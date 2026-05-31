'use strict'
/**
 * HorseStat 再構築スクリプト（/api/reanalyze と同等＋データ整合性修正版）
 * Next.js サーバー不要。直接 Prisma で DB を更新する。
 *
 *   node scripts/reanalyze.js
 *
 * v3 修正点（2026-05-31 オッズ非依存・実力系特徴量の追加）:
 *  - 走破タイム→スピード指数(z)、通過順位→脚質、上がり3F、過去人気の集計を追加。
 *    これらは「予想時点（数日前・オッズ未確定）でも使える」リーク無しの実力指標。
 *  - スピード指数の正規化テーブル(ml/speed_norms.json)を出力し、build_dataset.py と
 *    完全に同じ式で算出することで train/serve parity を保証する。
 *  - 血統(sire等)を破壊しない: deleteMany 前に既存血統を退避し createMany で復元。
 *    （fetch_pedigree.js が別途埋める血統を再集計で消さないため）
 *
 * v2 修正点:
 *  - recentForm チャンク分割バグ修正（グローバル集約）
 *  - 重複レース統合（同一馬で 4 日以内＝同一レースの二重登録, 非破壊）
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

function loadEnv(f) {
  try {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()

const GRADE_RANK = { 'G1': 4, 'G2': 3, 'G3': 2, '通常': 1 }
const DEDUP_DAYS = 4  // 同一馬でこの日数以内の結果は同一レースの重複とみなす
const NORMS_PATH = path.join(__dirname, '..', 'ml', 'speed_norms.json')

// === build_dataset.py と完全一致させること（train/serve parity） ===
// 既定値: 過去走データが無い場合のフォールバック
const DEF_SPEED = 0.0, DEF_POSRATIO = 0.5, DEF_FRONT = 0.0, DEF_R3F = 35.0, DEF_POP = 9

function parseTimeSec(t) {
  if (!t) return null
  const m = String(t).match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const total = (m[1] ? parseInt(m[1]) : 0) * 60 + parseFloat(m[2])
  return total > 0 && total < 1200 ? total : null
}

function firstCorner(cp) {
  if (!cp) return null
  const n = parseInt(String(cp).split('-')[0])
  return Number.isFinite(n) && n > 0 ? n : null
}

function speedZ(norms, venue, surface, distance, sec) {
  if (sec == null) return null
  const g = norms[`${venue}-${surface}-${distance}`]
  if (!g || g.n < 20) return null
  const z = (g.mean - sec) / Math.max(g.std, 0.1)  // 速い(短い)= 正
  return Math.max(-5, Math.min(5, z))
}

function styleFromRatio(r) {
  if (r == null) return null
  if (r <= 0.15) return '逃'
  if (r <= 0.35) return '先'
  if (r <= 0.65) return '差'
  return '追'
}

function getIntervalBin(days) {
  if (days <= 13)  return 'rensen'
  if (days <= 20)  return 'standard2'
  if (days <= 27)  return 'standard3'
  if (days <= 34)  return 'standard4'
  if (days <= 41)  return 'standard5'
  if (days <= 62)  return 'medium'
  if (days <= 119) return 'shortRest'
  if (days <= 180) return 'midRest'
  return 'longRest'
}

function normalizeRaceName(name) {
  return (name || '').replace(/\s*\d{4}年?\s*$/, '').replace(/\([^)]*\)/g, '').trim()
}

// 2 つの重複候補から情報量の多い方を採用しつつ各属性をマージ
function mergeDup(a, b) {
  const score = (x) => (x.popularity != null ? 4 : 0) + (x.horseWeight != null ? 2 : 0) + (x.position < 99 ? 1 : 0)
  const keep = score(b) > score(a) ? b : a
  const other = keep === a ? b : a
  const pick = (k) => keep[k] != null ? keep[k] : other[k]
  return {
    date: keep.date,
    position: keep.position < 99 ? keep.position : (other.position < 99 ? other.position : keep.position),
    popularity: pick('popularity'),
    horseWeight: pick('horseWeight'),
    speedZ: pick('speedZ'),
    posRatio: pick('posRatio'),
    r3f: pick('r3f'),
    grade: (GRADE_RANK[keep.grade] ?? 1) >= (GRADE_RANK[other.grade] ?? 1) ? keep.grade : other.grade,
    venue: keep.venue, surface: keep.surface, distance: keep.distance,
    trackCondition: keep.trackCondition ?? other.trackCondition,
    name: keep.name,
  }
}

function dedupFinishes(finishesAsc) {
  const out = []
  for (const f of finishesAsc) {
    const last = out[out.length - 1]
    if (last && (f.date - last.date) <= DEDUP_DAYS * 86400000) {
      out[out.length - 1] = mergeDup(last, f)
    } else {
      out.push(f)
    }
  }
  return out
}

function add(map, key, placed) {
  if (!map[key]) map[key] = { races: 0, places: 0 }
  map[key].races++; if (placed) map[key].places++
}

const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null

async function main() {
  console.log('\n=== HorseStat 再構築 (v3: speed/style/pop + 血統保全) ===')
  const startAt = Date.now()

  // 既存血統を退避（再集計で消さない）
  console.log('  既存血統を退避中...')
  const pedMap = new Map()
  for (const h of await prisma.horseStat.findMany({
    where: { sire: { not: null } },
    select: { horseName: true, sire: true, dam: true, sireOfSire: true, damOfSire: true, sireOfDam: true, damOfDam: true },
  })) {
    pedMap.set(h.horseName, h)
  }
  console.log(`  血統保持: ${pedMap.size} 頭`)

  // 全馬の全 finishes をグローバルに集約
  const finishesMap = new Map()
  const normAcc = new Map()  // `${surface}-${distance}` -> {sum, sumsq, n}

  const CHUNK = 5000
  let skip = 0, totalRaces = 0
  while (true) {
    const chunk = await prisma.race.findMany({
      take: CHUNK, skip, orderBy: { id: 'asc' },
      select: {
        name: true, grade: true, venue: true, surface: true, distance: true, date: true, trackCondition: true,
        results: {
          where: { finishPosition: { not: null } },
          select: { horseName: true, finishPosition: true, popularity: true, horseWeight: true, time: true, cornerPositions: true, rapidIncrease: true },
        },
      },
    })
    if (chunk.length === 0) break
    skip += chunk.length; totalRaces += chunk.length
    for (const r of chunk) {
      const dms = new Date(r.date).getTime()
      const fieldSize = r.results.length
      for (const res of r.results) {
        const hn = res.horseName?.trim()
        if (!hn || res.finishPosition == null) continue
        const sec = parseTimeSec(res.time)
        if (sec != null) {  // スピード正規化テーブル用に時間を蓄積
          const k = `${r.venue}-${r.surface}-${r.distance}`
          const acc = normAcc.get(k) ?? { sum: 0, sumsq: 0, n: 0 }
          acc.sum += sec; acc.sumsq += sec * sec; acc.n++; normAcc.set(k, acc)
        }
        const fc = firstCorner(res.cornerPositions)
        if (!finishesMap.has(hn)) finishesMap.set(hn, [])
        finishesMap.get(hn).push({
          date: dms, position: res.finishPosition, popularity: res.popularity ?? null,
          horseWeight: res.horseWeight ?? null, grade: r.grade, venue: r.venue,
          surface: r.surface, distance: r.distance, trackCondition: r.trackCondition ?? null, name: r.name,
          _sec: sec, _fc: fc, _fieldSize: fieldSize, r3f: res.rapidIncrease ?? null,
          posRatio: fc != null && fieldSize > 0 ? Math.max(0, Math.min(1, fc / fieldSize)) : null,
          speedZ: null,  // norms 確定後に算出
        })
      }
    }
    process.stdout.write(`  読み込み中... ${totalRaces} レース / ${finishesMap.size} 頭\r`)
  }

  // スピード正規化テーブル確定 → 出力（build_dataset.py と共用）
  const norms = {}
  normAcc.forEach((a, k) => {
    const m = a.sum / a.n
    const variance = Math.max(0, a.sumsq / a.n - m * m)
    norms[k] = { mean: m, std: Math.sqrt(variance), n: a.n }
  })
  fs.mkdirSync(path.dirname(NORMS_PATH), { recursive: true })
  fs.writeFileSync(NORMS_PATH, JSON.stringify(norms))
  console.log(`\n  読み込み完了: ${totalRaces} レース / ${finishesMap.size} 頭。norms ${Object.keys(norms).length} 群 → ${path.relative(process.cwd(), NORMS_PATH)}`)
  console.log('  集計中...')

  const freshStats = []
  let dupRemoved = 0
  finishesMap.forEach((finishes, horseName) => {
    finishes.sort((a, b) => a.date - b.date)
    // speedZ を norms で算出してから dedup
    for (const f of finishes) f.speedZ = speedZ(norms, f.venue, f.surface, f.distance, f._sec)
    const before = finishes.length
    const fin = dedupFinishes(finishes)
    dupRemoved += before - fin.length

    const s = {
      horseName,
      totalRaces: 0, totalPlaces: 0,
      g1Races: 0, g1Places: 0, g2Races: 0, g2Places: 0, g3Races: 0, g3Places: 0,
      distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
      trackCondData: {}, intervalData: {}, courseDistData: {},
      avgHorseWeight: null, weightSamples: 0,
      lastRaceDate: null, lastRacePopularity: null,
      recentForm: null, recentGrades: null, recentPops: null,
      bestSpeed: null, avgSpeed3: null, lastSpeed: null,
      avgPosRatio: null, frontRate: null, runningStyle: null,
      bestR3f: null, avgR3f3: null, avgRecentPop: null, bestRecentPop: null,
    }
    const weights = []
    for (const f of fin) {
      const placed = f.position <= 2
      s.totalRaces++; if (placed) s.totalPlaces++
      if (f.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
      else if (f.grade === 'G2') { s.g2Races++; if (placed) s.g2Places++ }
      else if (f.grade === 'G3') { s.g3Races++; if (placed) s.g3Places++ }
      add(s.distanceData, String(f.distance), placed)
      add(s.venueData, f.venue, placed)
      add(s.surfaceData, f.surface, placed)
      add(s.raceNameData, normalizeRaceName(f.name), placed)
      add(s.courseDistData, `${f.venue}-${f.surface}-${f.distance}`, placed)
      if (f.trackCondition) add(s.trackCondData, f.trackCondition, placed)
      if (f.horseWeight != null && f.horseWeight > 0) weights.push(f.horseWeight)
    }
    for (let i = 1; i < fin.length; i++) {
      const days = Math.floor((fin[i].date - fin[i - 1].date) / 86400000)
      if (days <= 0) continue
      add(s.intervalData, getIntervalBin(days), fin[i].position <= 2)
    }
    // --- 実力系集計（全 deduped 走を prior とみなす。未来レース予想時は全走が prior） ---
    const speeds = fin.map(f => f.speedZ).filter(v => v != null)
    const posRatios = fin.map(f => f.posRatio).filter(v => v != null)
    const r3fs = fin.map(f => f.r3f).filter(v => v != null)
    const last3speed = fin.slice(-3).map(f => f.speedZ).filter(v => v != null)
    const last3r3f = fin.slice(-3).map(f => f.r3f).filter(v => v != null)
    const last5pop = fin.slice(-5).map(f => f.popularity == null ? DEF_POP : f.popularity)

    s.bestSpeed = speeds.length ? Math.max(...speeds) : DEF_SPEED
    s.avgSpeed3 = last3speed.length ? mean(last3speed) : DEF_SPEED
    s.lastSpeed = speeds.length ? speeds[speeds.length - 1] : DEF_SPEED
    s.avgPosRatio = posRatios.length ? mean(posRatios) : DEF_POSRATIO
    s.frontRate = posRatios.length ? posRatios.filter(r => r <= 0.3).length / posRatios.length : DEF_FRONT
    s.runningStyle = styleFromRatio(posRatios.length ? mean(posRatios) : null)
    s.bestR3f = r3fs.length ? Math.min(...r3fs) : DEF_R3F
    s.avgR3f3 = last3r3f.length ? mean(last3r3f) : DEF_R3F
    s.avgRecentPop = last5pop.length ? mean(last5pop) : DEF_POP
    s.bestRecentPop = last5pop.length ? Math.min(...last5pop) : DEF_POP

    const recent = fin.slice(-5).reverse()
    s.recentForm   = recent.map(f => f.position).join('-')
    s.recentGrades = recent.map(f => f.grade).join('-')
    s.recentPops   = recent.map(f => f.popularity ?? 0).join('-')
    const lastF = fin[fin.length - 1]
    s.lastRaceDate = new Date(lastF.date)
    s.lastRacePopularity = lastF.popularity ?? null
    if (weights.length) { s.avgHorseWeight = weights.reduce((a, b) => a + b, 0) / weights.length; s.weightSamples = weights.length }
    freshStats.push(s)
  })

  console.log(`  集計完了: ${freshStats.length} 頭 / 重複統合: ${dupRemoved} 行`)
  console.log('  HorseStat 全件削除中...')
  await prisma.horseStat.deleteMany({})

  console.log(`  HorseStat 書き込み中... (${freshStats.length} 頭)`)
  let saved = 0
  const WRITE_CHUNK = 500
  for (let i = 0; i < freshStats.length; i += WRITE_CHUNK) {
    const batch = freshStats.slice(i, i + WRITE_CHUNK)
    await prisma.horseStat.createMany({
      data: batch.map(hs => {
        const ped = pedMap.get(hs.horseName)
        return {
          horseName: hs.horseName,
          totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
          g1Races: hs.g1Races, g1Places: hs.g1Places,
          g2Races: hs.g2Races, g2Places: hs.g2Places,
          g3Races: hs.g3Races, g3Places: hs.g3Places,
          distanceData: hs.distanceData, venueData: hs.venueData,
          surfaceData: hs.surfaceData, raceNameData: hs.raceNameData,
          trackCondData: hs.trackCondData, intervalData: hs.intervalData, courseDistData: hs.courseDistData,
          avgHorseWeight: hs.avgHorseWeight, weightSamples: hs.weightSamples,
          lastRaceDate: hs.lastRaceDate, lastRacePopularity: hs.lastRacePopularity,
          recentForm: hs.recentForm, recentGrades: hs.recentGrades, recentPops: hs.recentPops,
          runningStyle: hs.runningStyle,
          bestSpeed: hs.bestSpeed, avgSpeed3: hs.avgSpeed3, lastSpeed: hs.lastSpeed,
          avgPosRatio: hs.avgPosRatio, frontRate: hs.frontRate,
          bestR3f: hs.bestR3f, avgR3f3: hs.avgR3f3,
          avgRecentPop: hs.avgRecentPop, bestRecentPop: hs.bestRecentPop,
          // 退避した血統を復元（あれば）
          ...(ped ? { sire: ped.sire, dam: ped.dam, sireOfSire: ped.sireOfSire, damOfSire: ped.damOfSire, sireOfDam: ped.sireOfDam, damOfDam: ped.damOfDam } : {}),
        }
      }),
      skipDuplicates: true,
    })
    saved += batch.length
    process.stdout.write(`  書き込み: ${saved} / ${freshStats.length}\r`)
  }

  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1)
  console.log(`\n\n=== 完了 ===`)
  console.log(`  保存: ${saved} 頭 / ${totalRaces} レース / 重複統合 ${dupRemoved} 行 / 血統復元 ${pedMap.size} 頭 (${elapsed}秒)`)
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
