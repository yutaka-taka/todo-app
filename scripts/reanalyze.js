'use strict'
/**
 * HorseStat 再構築スクリプト（/api/reanalyze と同等＋データ整合性修正版）
 * Next.js サーバー不要。直接 Prisma で DB を更新する。
 *
 *   node scripts/reanalyze.js
 *
 * v2 修正点（2026-05-31 精度向上整備）:
 *  - recentForm チャンク分割バグ修正: 馬ごとの全レースをグローバルに集約してから
 *    recentForm/recentGrades/recentPops/intervalData を計算（旧版は id 順チャンク内
 *    だけで計算し、最新レースを含むチャンクで上書きするため form が 1 要素に潰れていた）。
 *  - 重複レース統合（非破壊）: 同一馬で 4 日以内の結果は同一レースの二重登録とみなし
 *    1 件に統合（人気/オッズ/馬体重が揃う行を優先、グレードは上位を採用）。
 *    馬は物理的に 4 日以内に別レースへ出走できないため安全。
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

// 2 つの重複候補から情報量の多い方を採用しつつグレード等をマージ
function mergeDup(a, b) {
  const score = (x) => (x.popularity != null ? 4 : 0) + (x.horseWeight != null ? 2 : 0) + (x.position < 99 ? 1 : 0)
  const keep = score(b) > score(a) ? b : a
  const other = keep === a ? b : a
  return {
    date: keep.date,
    // 着順は有効値（<99）を優先
    position: keep.position < 99 ? keep.position : (other.position < 99 ? other.position : keep.position),
    popularity: keep.popularity != null ? keep.popularity : other.popularity,
    horseWeight: keep.horseWeight != null ? keep.horseWeight : other.horseWeight,
    // グレードは上位を採用（誤ラベル耐性）
    grade: (GRADE_RANK[keep.grade] ?? 1) >= (GRADE_RANK[other.grade] ?? 1) ? keep.grade : other.grade,
    venue: keep.venue, surface: keep.surface, distance: keep.distance,
    trackCondition: keep.trackCondition ?? other.trackCondition,
    name: keep.name,
  }
}

// 馬ごとの時系列 finishes を 4 日以内重複で統合（日付昇順前提）
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

async function main() {
  console.log('\n=== HorseStat 再構築 (v2: dedup + global recentForm) ===')
  const startAt = Date.now()

  // 全馬の全 finishes をグローバルに集約（チャンク跨ぎでも form が正しく出る）
  const finishesMap = new Map()  // horseName -> [{date(ms),position,popularity,horseWeight,grade,venue,surface,distance,trackCondition,name}]

  const CHUNK = 5000
  let skip = 0, totalRaces = 0
  while (true) {
    const chunk = await prisma.race.findMany({
      take: CHUNK, skip, orderBy: { id: 'asc' },
      select: {
        name: true, grade: true, venue: true, surface: true, distance: true, date: true, trackCondition: true,
        results: {
          where: { finishPosition: { not: null } },
          select: { horseName: true, finishPosition: true, popularity: true, horseWeight: true },
        },
      },
    })
    if (chunk.length === 0) break
    skip += chunk.length; totalRaces += chunk.length
    for (const r of chunk) {
      const dms = new Date(r.date).getTime()
      for (const res of r.results) {
        const hn = res.horseName?.trim()
        if (!hn || res.finishPosition == null) continue
        if (!finishesMap.has(hn)) finishesMap.set(hn, [])
        finishesMap.get(hn).push({
          date: dms, position: res.finishPosition, popularity: res.popularity ?? null,
          horseWeight: res.horseWeight ?? null, grade: r.grade, venue: r.venue,
          surface: r.surface, distance: r.distance, trackCondition: r.trackCondition ?? null, name: r.name,
        })
      }
    }
    process.stdout.write(`  読み込み中... ${totalRaces} レース / ${finishesMap.size} 頭\r`)
  }
  console.log(`\n  読み込み完了: ${totalRaces} レース / ${finishesMap.size} 頭。集計中...`)

  const freshStats = []
  let dupRemoved = 0
  finishesMap.forEach((finishes, horseName) => {
    finishes.sort((a, b) => a.date - b.date)
    const before = finishes.length
    const fin = dedupFinishes(finishes)  // 日付昇順・重複統合済み
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
    // interval（日付昇順ペア）
    for (let i = 1; i < fin.length; i++) {
      const days = Math.floor((fin[i].date - fin[i - 1].date) / 86400000)
      if (days <= 0) continue
      add(s.intervalData, getIntervalBin(days), fin[i].position <= 2)
    }
    // recentForm（最新順、グローバルに正しく算出）
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
      data: batch.map(hs => ({
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
      })),
      skipDuplicates: true,
    })
    saved += batch.length
    process.stdout.write(`  書き込み: ${saved} / ${freshStats.length}\r`)
  }

  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1)
  console.log(`\n\n=== 完了 ===`)
  console.log(`  保存: ${saved} 頭 / ${totalRaces} レース / 重複統合 ${dupRemoved} 行 (${elapsed}秒)`)
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
