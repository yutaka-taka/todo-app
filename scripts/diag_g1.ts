/**
 * G1 自己予想 診断（本番コードをそのまま使用・point-in-time・リークなし）
 *
 * backtest_pipeline.ts と同じ walk-forward 蓄積で、過去 G1 を本番の
 * localScoreHorses + ML(mlBlend=0.9, staminaAdjust) で自己予想し、
 * 実結果(1-2着)と照合する。さらに「外した連対馬がモデル内で何位・なぜ外したか」を出す。
 *
 * 2 モードを同時評価:
 *   - withOdds : entries に当日人気/オッズを渡す（旧 backtest 相当・楽観）
 *   - noOdds   : 人気/オッズ=null（ユーザーの実利用＝数日前予想の現実条件）
 *
 *   npx tsx scripts/diag_g1.ts                # 2023-01-01 以降の G1 を診断
 *   npx tsx scripts/diag_g1.ts --eval-from=2024-01-01
 *   ML_MODEL_DIR=ml/models_rot npx tsx scripts/diag_g1.ts   # 候補モデルで診断
 */
import { PrismaClient, type HorseStat } from '@prisma/client'
import fs from 'fs'
import { localScoreHorses, DEFAULT_WEIGHTS, type ScoredHorse } from '../src/lib/scorer'
import { buildMLFeatures } from '../src/lib/mlFeatures'
import { predictML, isMLModelAvailable } from '../src/lib/mlInference'
import { adjustMlRatesForStamina } from '../src/lib/staminaAdjust'

const prisma = new PrismaClient()
const DAY = 86400000
const DEDUP_DAYS = 4
const GRADE_RANK: Record<string, number> = { G1: 4, G2: 3, G3: 2, '通常': 1 }
const ML_RATIO = Number(process.env.ML_BLEND_RATIO ?? 0.9)

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]
}))

type Fin = {
  date: number; pos: number; pop: number | null; hw: number | null; r3f: number | null
  grade: string; venue: string; surface: string; distance: number; trackCond: string | null; name: string
}

function normName(n: string) { return (n || '').replace(/\s*\d{4}年?\s*$/, '').replace(/\([^)]*\)/g, '').trim() }
function intervalBin(d: number) {
  if (d <= 13) return 'rensen'; if (d <= 20) return 'standard2'; if (d <= 27) return 'standard3'
  if (d <= 34) return 'standard4'; if (d <= 41) return 'standard5'; if (d <= 62) return 'medium'
  if (d <= 119) return 'shortRest'; if (d <= 180) return 'midRest'; return 'longRest'
}
function dupScore(f: Fin) { return (f.pop != null ? 4 : 0) + (f.hw != null ? 2 : 0) + (f.pos < 99 ? 1 : 0) }
function mergeDup(a: Fin, b: Fin): Fin {
  const keep = dupScore(b) > dupScore(a) ? b : a, oth = keep === a ? b : a
  return { ...keep, pos: keep.pos < 99 ? keep.pos : oth.pos,
    pop: keep.pop ?? oth.pop, hw: keep.hw ?? oth.hw, r3f: keep.r3f ?? oth.r3f,
    grade: (GRADE_RANK[oth.grade] ?? 1) > (GRADE_RANK[keep.grade] ?? 1) ? oth.grade : keep.grade }
}
function add(m: Record<string, { races: number; places: number }>, k: string, placed: boolean) {
  if (!m[k]) m[k] = { races: 0, places: 0 }; m[k].races++; if (placed) m[k].places++
}

function buildStat(name: string, fins: Fin[]): HorseStat {
  const s: Record<string, unknown> = {
    horseName: name, totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0, g2Races: 0, g2Places: 0,
    g3Races: 0, g3Places: 0, distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
    trackCondData: {}, intervalData: {}, courseDistData: {}, avgHorseWeight: null, weightSamples: 0,
    lastRaceDate: null, lastRacePopularity: null, recentForm: null, recentGrades: null, recentPops: null,
    sire: null, dam: null, sireOfSire: null, sireOfDam: null, damOfSire: null, damOfDam: null, runningStyle: null,
  }
  const weights: number[] = []
  for (const f of fins) {
    const placed = f.pos <= 2
    ;(s.totalRaces as number)++; if (placed) (s.totalPlaces as number)++
    if (f.grade === 'G1') { (s.g1Races as number)++; if (placed) (s.g1Places as number)++ }
    else if (f.grade === 'G2') { (s.g2Races as number)++; if (placed) (s.g2Places as number)++ }
    else if (f.grade === 'G3') { (s.g3Races as number)++; if (placed) (s.g3Places as number)++ }
    add(s.distanceData as never, String(f.distance), placed)
    add(s.venueData as never, f.venue, placed)
    add(s.surfaceData as never, f.surface, placed)
    add(s.courseDistData as never, `${f.venue}-${f.surface}-${f.distance}`, placed)
    if (f.trackCond) add(s.trackCondData as never, f.trackCond, placed)
    if (f.hw != null && f.hw > 0) weights.push(f.hw)
  }
  for (let i = 1; i < fins.length; i++) {
    const days = Math.floor((fins[i].date - fins[i - 1].date) / DAY)
    if (days > 0) add(s.intervalData as never, intervalBin(days), fins[i].pos <= 2)
  }
  const recent = fins.slice(-5).reverse()
  s.recentForm = recent.map(f => f.pos).join('-')
  s.recentGrades = recent.map(f => f.grade).join('-')
  s.recentPops = recent.map(f => f.pop ?? 0).join('-')
  const last = fins[fins.length - 1]
  s.lastRaceDate = new Date(last.date); s.lastRacePopularity = last.pop ?? null
  if (weights.length) { s.avgHorseWeight = weights.reduce((a, b) => a + b, 0) / weights.length; s.weightSamples = weights.length }
  // reanalyze.js が格納する実力系（speed/posRatio/r3f/recentPop）。バックテストでは
  // 最低限 avgRecentPop / bestRecentPop を過去走人気から復元する（ML特徴 last_race_pop 系の素）。
  const pops = fins.map(f => f.pop).filter((p): p is number => p != null)
  if (pops.length) {
    ;(s as Record<string, unknown>).avgRecentPop = pops.slice(-5).reduce((a, b) => a + b, 0) / Math.min(pops.length, 5)
    ;(s as Record<string, unknown>).bestRecentPop = Math.min(...pops)
  }
  return s as unknown as HorseStat
}

type MissInfo = {
  name: string; actualPos: number; actualPop: number | null; actualOdds: number | null
  mlRank: number; mlRate: number; totalRaces: number; placeRate: number
  recentForm: string | null; daysSinceLast: number | null
  coveredByDark: boolean
}
type ModeResult = {
  top5: { name: string; ml: number; reason: string }[]
  dark: { name: string; ml: number; rot: number }[]
  hit1: boolean; hit2: boolean; coverHit1: boolean; coverHit2: boolean; darkSize: number
  misses: MissInfo[]
}
type RaceDiag = {
  date: string; name: string; venue: string; surface: string; distance: number
  fieldSize: number
  actual: { name: string; pos: number; pop: number | null; odds: number | null }[]
  withOdds: ModeResult
  noOdds:   ModeResult
}

async function main() {
  const from = argv.from ? new Date(argv.from as string) : new Date('2014-01-01')
  const evalFrom = new Date((argv['eval-from'] as string) ?? '2023-01-01')
  console.log(`[diag] ML available: ${isMLModelAvailable()}  ML_MODEL_DIR=${process.env.ML_MODEL_DIR ?? 'ml/models'}  ratio=${ML_RATIO}`)
  console.log(`[diag] accumulate from ${from.toISOString().slice(0,10)} / evaluate G1 from ${evalFrom.toISOString().slice(0,10)}`)

  const races = await prisma.race.findMany({
    where: { date: { gte: from }, results: { some: { finishPosition: { not: null } } } },
    select: {
      id: true, name: true, date: true, venue: true, grade: true, surface: true, distance: true, trackCondition: true,
      results: { where: { finishPosition: { not: null } }, select: {
        horseName: true, horseNumber: true, finishPosition: true, age: true, jockey: true, trainer: true,
        popularity: true, odds: true, horseWeight: true, weightChange: true, rapidIncrease: true } },
    },
    orderBy: { date: 'asc' },
  })
  console.log(`[diag] races loaded: ${races.length}`)

  const acc = new Map<string, Fin[]>()
  const seen = new Set<string>()
  const diags: RaceDiag[] = []
  const agg = {
    withOdds: { t: 0, h1: 0, h2: 0, missFav: 0, missMid: 0, missLong: 0, recoverable: 0, ch1: 0, ch2: 0, darkSizeSum: 0, darkSaved: 0 },
    noOdds:   { t: 0, h1: 0, h2: 0, missFav: 0, missMid: 0, missLong: 0, recoverable: 0, ch1: 0, ch2: 0, darkSizeSum: 0, darkSaved: 0 },
  }
  // 市場ベースライン（最終人気 top5）＝正直な事前予想の天井ベンチマーク
  const mkt = { t: 0, h1: 0, h2: 0 }

  async function predictMode(
    entriesBase: Parameters<typeof localScoreHorses>[0],
    raceCtx: Parameters<typeof localScoreHorses>[1],
    stats: HorseStat[], statMap: Map<string, HorseStat>,
    mlRateMap: Map<string, number> | null, useOdds: boolean,
    actualPlacers: { name: string; pos: number; pop: number | null; odds: number | null }[],
  ) {
    const entries = entriesBase.map(e => useOdds ? e : { ...e, oddsPopularity: null, oddsFloat: null })
    const darkHorses: ScoredHorse[] = []
    const scored = localScoreHorses(entries, raceCtx, stats, DEFAULT_WEIGHTS, {
      selectionMode: 'multiaxis',
      mlBlend: mlRateMap ? { mlRateMap, mlWeight: ML_RATIO } : undefined,
      darkHorses,
    })
    const top5 = scored.slice(0, 5)
    const top5names = top5.map(s => s.horseName)
    const darkNames = darkHorses.map(s => s.horseName)
    const coverNames = new Set([...top5names, ...darkNames])  // top5 ∪ 伏兵
    const hits = actualPlacers.filter(a => top5names.includes(a.name)).length
    const coverHits = actualPlacers.filter(a => coverNames.has(a.name)).length

    // 全頭をスタミナ補正後MLで順位付け（外した連対馬がモデル内で何位かを診断）
    const adjusted = mlRateMap ? adjustMlRatesForStamina(mlRateMap, stats, raceCtx) : new Map<string, number>()
    const mlRanked = Array.from(adjusted.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0])

    const misses: MissInfo[] = []
    for (const a of actualPlacers) {
      if (top5names.includes(a.name)) continue
      const st = statMap.get(a.name)
      const mlRank = mlRanked.indexOf(a.name) + 1
      const lastDate = st?.lastRaceDate ? new Date(st.lastRaceDate).getTime() : null
      misses.push({
        name: a.name, actualPos: a.pos, actualPop: a.pop, actualOdds: a.odds,
        mlRank: mlRank || -1, mlRate: Math.round((adjusted.get(a.name) ?? 0) * 10) / 10,
        totalRaces: st?.totalRaces ?? 0,
        placeRate: st && st.totalRaces ? Math.round(100 * st.totalPlaces / st.totalRaces) / 100 : 0,
        recentForm: st?.recentForm ?? null,
        daysSinceLast: lastDate ? Math.floor((new Date(raceCtx.date as Date).getTime() - lastDate) / DAY) : null,
        coveredByDark: darkNames.includes(a.name),
      })
    }
    return {
      top5: top5.map(s => ({ name: s.horseName, ml: Math.round((s._mlRate ?? s.placeRate) * 10) / 10, reason: s._selectionReason ?? '' })),
      dark: darkHorses.map(s => ({ name: s.horseName, ml: Math.round((s._mlRate ?? 0) * 10) / 10, rot: s._rotationSignal ?? 0 })),
      hit1: hits >= 1, hit2: hits >= 2,
      coverHit1: coverHits >= 1, coverHit2: coverHits >= 2, darkSize: darkHorses.length,
      misses,
    }
  }

  let evaluated = 0
  for (const race of races) {
    const d = new Date(race.date).getTime()
    const isG1 = race.grade === 'G1'
    const key = `${normName(race.name)}|${race.venue}|${race.surface}|${race.distance}|${Math.round(d / DAY / 3)}`
    const isDupTarget = isG1 && seen.has(key)

    if (isG1 && !isDupTarget && d >= evalFrom.getTime()) {
      const results = race.results.filter(r => r.finishPosition != null)
      const actual = results.filter(r => (r.finishPosition ?? 99) <= 2)
        .map(r => ({ name: r.horseName, pos: r.finishPosition as number, pop: r.popularity ?? null, odds: r.odds ?? null }))
      if (results.length >= 5 && actual.length >= 2) {
        const entries = results.map(r => {
          const prior = acc.get(r.horseName)
          const priorR3f = prior && prior.length ? prior[prior.length - 1].r3f : null
          return {
            horseNumber: r.horseNumber, horseName: r.horseName, age: r.age ?? null,
            jockey: r.jockey ?? null, trainer: r.trainer ?? null,
            horseWeight: r.horseWeight ?? null, weightChange: r.weightChange ?? null,
            frameNumber: null as number | null, lastThreeFurlong: priorR3f, runningStyle: null as string | null,
            oddsPopularity: r.popularity ?? null, oddsFloat: r.odds ?? null,
          }
        })
        const stats = entries.filter(e => acc.get(e.horseName)?.length).map(e => buildStat(e.horseName, acc.get(e.horseName)!))
        const statMap = new Map(stats.map(s => [s.horseName, s]))
        const raceCtx = { name: race.name, grade: race.grade, distance: race.distance, venue: race.venue, surface: race.surface, trackCondition: race.trackCondition ?? undefined, date: new Date(d) }

        let mlRateMap: Map<string, number> | null = null
        if (isMLModelAvailable()) {
          const inputs = entries.map(e => buildMLFeatures({ ...e }, raceCtx, statMap.get(e.horseName) ?? null))
          const probs = await predictML(inputs)
          if (probs) mlRateMap = new Map(entries.map((e, i) => [e.horseName, (probs[i] ?? 0.11) * 100]))
        }

        const wo = await predictMode(entries, raceCtx, stats, statMap, mlRateMap, true, actual)
        const no = await predictMode(entries, raceCtx, stats, statMap, mlRateMap, false, actual)

        // 市場ベースライン: 最終人気の上位5頭（人気がある馬のみ）
        const withPop = results.filter(r => r.popularity != null).sort((a, b) => (a.popularity as number) - (b.popularity as number))
        if (withPop.length >= 5) {
          const m5 = withPop.slice(0, 5).map(r => r.horseName)
          const mh = actual.filter(a => m5.includes(a.name)).length
          mkt.t++; if (mh >= 1) mkt.h1++; if (mh >= 2) mkt.h2++
        }

        diags.push({
          date: new Date(d).toISOString().slice(0, 10), name: race.name, venue: race.venue,
          surface: race.surface, distance: race.distance, fieldSize: results.length,
          actual, withOdds: wo, noOdds: no,
        })
        for (const [mode, r] of [['withOdds', wo], ['noOdds', no]] as const) {
          const a = agg[mode]
          a.t++; if (r.hit1) a.h1++; if (r.hit2) a.h2++
          // 統合recall（top5 ∪ 伏兵）= 予想出力に連対馬が出現したか
          if (r.coverHit1) a.ch1++; if (r.coverHit2) a.ch2++
          a.darkSizeSum += r.darkSize
          for (const m of r.misses) {
            const pop = m.actualPop ?? 99
            if (pop <= 3) a.missFav++          // 人気馬の取りこぼし＝モデルの明確な失敗
            else if (pop <= 8) a.missMid++     // 中位人気
            else a.missLong++                   // 人気薄＝市場も外す本質的に難しい馬
            // モデル内 6-12位に沈めていた＝拾えた可能性（recoverable）
            if (m.mlRank >= 6 && m.mlRank <= 12 && pop <= 8) a.recoverable++
            // top5で外したが伏兵枠で救済できた連対馬
            if (m.coveredByDark) a.darkSaved++
          }
        }
        evaluated++
      }
      seen.add(key)
    }

    for (const r of race.results) {
      if (r.finishPosition == null) continue
      const f: Fin = { date: d, pos: r.finishPosition, pop: r.popularity ?? null, hw: r.horseWeight ?? null,
        r3f: r.rapidIncrease ?? null, grade: race.grade, venue: race.venue, surface: race.surface,
        distance: race.distance, trackCond: race.trackCondition ?? null, name: race.name }
      let arr = acc.get(r.horseName); if (!arr) { arr = []; acc.set(r.horseName, arr) }
      const last = arr[arr.length - 1]
      if (last && (f.date - last.date) <= DEDUP_DAYS * DAY) arr[arr.length - 1] = mergeDup(last, f)
      else arr.push(f)
    }
  }

  // ===== レポート =====
  console.log(`\n[diag] 評価G1数: ${evaluated}\n`)
  for (const mode of ['withOdds', 'noOdds'] as const) {
    const a = agg[mode]
    const pct = (x: number) => a.t ? (100 * x / a.t).toFixed(1) + '%' : '-'
    console.log(`=== ${mode === 'withOdds' ? 'オッズ有り(楽観)' : 'オッズ無し(実利用=数日前)'} ===`)
    console.log(`  Hit@5(1)=${pct(a.h1)}  Hit@5(2)=${pct(a.h2)}   (G1 ${a.t}件)`)
    console.log(`  統合recall(top5∪伏兵)  出現(1)=${pct(a.ch1)}  両連対出現(2)=${pct(a.ch2)}   伏兵平均${(a.darkSizeSum / (a.t || 1)).toFixed(1)}頭/レース・救済${a.darkSaved}頭`)
    const missTotal = a.missFav + a.missMid + a.missLong
    console.log(`  取りこぼし連対馬 計${missTotal}頭: 人気1-3=${a.missFav} / 4-8=${a.missMid} / 9人気以下=${a.missLong}`)
    console.log(`  うちモデル6-12位(人気8位以内)に沈めた=${a.recoverable}頭（拾えた可能性のある取りこぼし）\n`)
  }
  {
    const pct = (x: number) => mkt.t ? (100 * x / mkt.t).toFixed(1) + '%' : '-'
    console.log(`=== 市場ベースライン（最終人気top5・正直な事前予想の天井）===`)
    console.log(`  Hit@5(1)=${pct(mkt.h1)}  Hit@5(2)=${pct(mkt.h2)}   (G1 ${mkt.t}件)\n`)
  }

  // 実利用モード(noOdds)で外した「人気馬(1-5人気)の取りこぼし」を列挙＝最も問題
  console.log('===== 実利用(オッズ無し)で外した 人気5位以内の連対馬（モデルの明確な弱点）=====')
  const badMisses: { d: RaceDiag; m: MissInfo }[] = []
  for (const d of diags) for (const m of d.noOdds.misses) if ((m.actualPop ?? 99) <= 5) badMisses.push({ d, m })
  badMisses.sort((x, y) => (x.m.actualPop ?? 99) - (y.m.actualPop ?? 99))
  for (const { d, m } of badMisses) {
    const mark = m.coveredByDark ? '🐎伏兵救済' : '❌未救済'
    console.log(`  [${mark}] ${d.date} ${d.name}(${d.surface}${d.distance}) ${m.name} 実${m.actualPos}着/${m.actualPop}人気 → モデルML${m.mlRank}位(${m.mlRate}%) 戦${m.totalRaces}/連対率${m.placeRate} form[${m.recentForm}] 間隔${m.daysSinceLast}日`)
  }

  fs.mkdirSync('logs', { recursive: true })
  fs.writeFileSync('logs/diag_g1.json', JSON.stringify({ agg, diags }, null, 2))
  console.log(`\n[diag] 詳細を logs/diag_g1.json に保存`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
