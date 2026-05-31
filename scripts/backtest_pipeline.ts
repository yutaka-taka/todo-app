/**
 * フルパイプライン walk-forward backtest（本番コードをそのまま使用）
 *
 * 本番の src/lib/scorer.ts (localScoreHorses + 多軸選定) と ML (mlFeatures/mlInference) を
 * 使い、重賞レースを日付順に point-in-time 評価する。各レース評価時点では、その馬の
 * 「対象レースより前の deduped レース」のみから HorseStat を materialize する（リークなし）。
 *
 * ML比率 0.0（=旧挙動: ヒューリスティック主導の選定）から 1.0 までを比較し、
 * ML が選定を主導することで Hit@5 がどう変わるか・最適 ML_BLEND_RATIO を測定する。
 *
 *   npx tsx scripts/backtest_pipeline.ts
 *   npx tsx scripts/backtest_pipeline.ts --from=2023-01-01
 */
import { PrismaClient, type HorseStat } from '@prisma/client'
import { localScoreHorses, DEFAULT_WEIGHTS } from '../src/lib/scorer'
import { buildMLFeatures } from '../src/lib/mlFeatures'
import { predictML, isMLModelAvailable } from '../src/lib/mlInference'

const prisma = new PrismaClient()
const DAY = 86400000
const DEDUP_DAYS = 4
const GRADE_RANK: Record<string, number> = { G1: 4, G2: 3, G3: 2, '通常': 1 }

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

// prior finishes（dedup済・日付昇順）から HorseStat 相当を materialize
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
  return s as unknown as HorseStat
}

async function main() {
  const from = argv.from ? new Date(argv.from as string) : new Date('2014-01-01')
  console.log(`[backtest] ML available: ${isMLModelAvailable()}  from=${from.toISOString().slice(0, 10)}`)

  // 全レース（結果付き）を日付順に。重賞のみ評価するが、統計は全レースから蓄積。
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
  console.log(`[backtest] races loaded: ${races.length}`)

  const acc = new Map<string, Fin[]>()
  const seen = new Set<string>()  // 評価済み重賞（重複コピー回避）
  const RATIOS = [0.0, 0.3, 0.5, 0.7, 0.8, 0.9, 1.0]
  const stat: Record<number, { total: number; h1: number; h2: number; g1t: number; g1h1: number; g1h2: number }> = {}
  for (const r of RATIOS) stat[r] = { total: 0, h1: 0, h2: 0, g1t: 0, g1h1: 0, g1h2: 0 }

  let evaluated = 0
  for (const race of races) {
    const d = new Date(race.date).getTime()
    const graded = (GRADE_RANK[race.grade] ?? 1) >= 2
    const key = `${normName(race.name)}|${race.venue}|${race.surface}|${race.distance}|${Math.round(d / DAY / 3)}`
    const isDupTarget = graded && seen.has(key)

    if (graded && !isDupTarget) {
      const results = race.results.filter(r => r.finishPosition != null)
      const actual = results.filter(r => (r.finishPosition ?? 99) <= 2).map(r => r.horseName)
      if (results.length >= 5 && actual.length >= 2) {
        // entries + as-of stats
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

        // ML確率（比率非依存。1回だけ）
        let mlRateMap: Map<string, number> | null = null
        if (isMLModelAvailable()) {
          const inputs = entries.map(e => buildMLFeatures({ ...e }, raceCtx, statMap.get(e.horseName) ?? null))
          const probs = await predictML(inputs)
          if (probs) mlRateMap = new Map(entries.map((e, i) => [e.horseName, (probs[i] ?? 0.11) * 100]))
        }

        const isG1 = race.grade === 'G1'
        for (const ratio of RATIOS) {
          const scored = localScoreHorses(entries, raceCtx, stats, DEFAULT_WEIGHTS, {
            selectionMode: 'multiaxis',
            mlBlend: mlRateMap ? { mlRateMap, mlWeight: ratio } : undefined,
          })
          const top5 = scored.slice(0, 5).map(s => s.horseName)
          const hits = actual.filter(n => top5.includes(n)).length
          const st = stat[ratio]
          st.total++; if (hits >= 1) st.h1++; if (hits >= 2) st.h2++
          if (isG1) { st.g1t++; if (hits >= 1) st.g1h1++; if (hits >= 2) st.g1h2++ }
        }
        evaluated++
        if (evaluated % 200 === 0) process.stdout.write(`  evaluated ${evaluated} 重賞...\r`)
      }
      seen.add(key)
    }

    // 統計更新（評価後 = point-in-time。dup コピーは merge）
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

  console.log(`\n[backtest] 評価重賞数: ${evaluated}\n`)
  console.log('ML比率 | 重賞 Hit@5(1) | 重賞 Hit@5(2) | G1 Hit@5(1) | G1 Hit@5(2)')
  console.log('-------|--------------|--------------|-------------|------------')
  for (const r of RATIOS) {
    const s = stat[r]
    const f = (a: number, b: number) => b ? (100 * a / b).toFixed(1) + '%' : '-'
    const tag = r === 0.0 ? ' (旧:ヒューリスティック選定)' : r === 1.0 ? ' (ML単体選定)' : ''
    console.log(` ${r.toFixed(1)}  |   ${f(s.h1, s.total).padStart(6)}     |   ${f(s.h2, s.total).padStart(6)}     |  ${f(s.g1h1, s.g1t).padStart(6)}    |  ${f(s.g1h2, s.g1t).padStart(6)}${tag}`)
  }
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
