/**
 * A(ローテML特徴) / B(selectFinalFive ローテ妙味枠) の効果を集計バックテストで検証する。
 * backtest_stamina.ts と同じ walk-forward / point-in-time 設計。
 *
 * ML モデルは ML_MODEL_DIR で選ぶ（既定 ml/models=38特徴、ml/models_rot=42特徴=A案）。
 * 各 arm:
 *   base       : rotationPick OFF
 *   +B         : rotationPick ON
 * を同一レースで並走。ML_MODEL_DIR を切り替えて2回実行すれば base / B / A / A+B の4点が揃う。
 *
 *   ML_MODEL_DIR=ml/models     npx tsx scripts/backtest_rotation.ts --from=2022-01-01   # base / B
 *   ML_MODEL_DIR=ml/models_rot npx tsx scripts/backtest_rotation.ts --from=2022-01-01   # A / A+B
 *
 * バステール検証: 2026東京優駿で「実3着バステール」が top5 入りした arm を出力。
 */
import { PrismaClient, type HorseStat } from '@prisma/client'
import { localScoreHorses, DEFAULT_WEIGHTS } from '../src/lib/scorer'
import { buildMLFeatures } from '../src/lib/mlFeatures'
import { predictML, isMLModelAvailable, getMLMeta } from '../src/lib/mlInference'

const prisma = new PrismaClient()
const DAY = 86400000
const DEDUP_DAYS = 4
const GRADE_RANK: Record<string, number> = { G1: 4, G2: 3, G3: 2, '通常': 1 }
const LONGSHOT_POP = 8

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

// recentForm/Grades/Pops を含む HorseStat を materialize（ローテ特徴に必須）
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

type Arm = { total: number; h1: number; h2: number; g1t: number; g1h1: number; g1h2: number; lsTotal: number; lsHit: number }
const mkArm = (): Arm => ({ total: 0, h1: 0, h2: 0, g1t: 0, g1h1: 0, g1h2: 0, lsTotal: 0, lsHit: 0 })

async function main() {
  const from = argv.from ? new Date(argv.from as string) : new Date('2022-01-01')
  const ratio = argv.ratio ? Math.max(0, Math.min(1, parseFloat(argv.ratio as string))) : 0.9
  const meta = getMLMeta()
  console.log(`[backtest-rotation] ML=${isMLModelAvailable()} dir=${process.env.ML_MODEL_DIR ?? 'ml/models'} feat=${meta?.feature_cols?.length} AUC=${meta?.test_auc?.toFixed(4)} from=${from.toISOString().slice(0,10)} ratio=${ratio}`)

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
  console.log(`[backtest-rotation] races loaded: ${races.length}`)

  const acc = new Map<string, Fin[]>()
  const seen = new Set<string>()
  const base = mkArm(), withB = mkArm()
  let evaluated = 0
  let bastailBase = '', bastailB = ''

  for (const race of races) {
    const d = new Date(race.date).getTime()
    const graded = (GRADE_RANK[race.grade] ?? 1) >= 2
    const key = `${normName(race.name)}|${race.venue}|${race.surface}|${race.distance}|${Math.round(d / DAY / 3)}`
    const isDupTarget = graded && seen.has(key)

    if (graded && !isDupTarget) {
      const results = race.results.filter(r => r.finishPosition != null)
      const actual = results.filter(r => (r.finishPosition ?? 99) <= 2)
      const actualNames = actual.map(r => r.horseName)
      if (results.length >= 5 && actualNames.length >= 2) {
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
        const isG1 = race.grade === 'G1'
        const longshotActual = actual.filter(r => (r.popularity ?? 0) >= LONGSHOT_POP).map(r => r.horseName)
        const isDerby = normName(race.name) === '東京優駿' || normName(race.name) === '日本ダービー'

        const evalArm = (arm: Arm, rotationPick: boolean): string[] => {
          const scored = localScoreHorses(entries, raceCtx, stats, DEFAULT_WEIGHTS, {
            selectionMode: 'multiaxis',
            mlBlend: mlRateMap ? { mlRateMap, mlWeight: ratio } : undefined,
            staminaAdjust: true, rotationPick,
          })
          const top5 = scored.slice(0, 5).map(s => s.horseName)
          const hits = actualNames.filter(n => top5.includes(n)).length
          arm.total++; if (hits >= 1) arm.h1++; if (hits >= 2) arm.h2++
          if (isG1) { arm.g1t++; if (hits >= 1) arm.g1h1++; if (hits >= 2) arm.g1h2++ }
          for (const ls of longshotActual) { arm.lsTotal++; if (top5.includes(ls)) arm.lsHit++ }
          return top5
        }

        const t1 = evalArm(base, false)
        const t2 = evalArm(withB, true)
        if (isDerby) { bastailBase = t1.includes('バステール') ? 'top5入り◎' : '圏外'; bastailB = t2.includes('バステール') ? 'top5入り◎' : '圏外' }
        evaluated++
        if (evaluated % 200 === 0) process.stdout.write(`  evaluated ${evaluated} 重賞...\r`)
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

  const pct = (a: number, b: number) => b ? (100 * a / b).toFixed(1) + '%' : '-'
  const row = (label: string, a: Arm) =>
    `${label.padEnd(16)}| ${pct(a.h1, a.total).padStart(6)} | ${pct(a.h2, a.total).padStart(6)} | ${pct(a.g1h1, a.g1t).padStart(6)} | ${pct(a.g1h2, a.g1t).padStart(6)} | ${pct(a.lsHit, a.lsTotal).padStart(6)} (${a.lsHit}/${a.lsTotal})`
  const dir = process.env.ML_MODEL_DIR ?? 'ml/models'
  const tag = dir === 'ml/models_rot' ? 'A(42feat)' : dir.includes('backup') ? 'base(38feat)' : 'PROD'
  console.log(`\n\n[backtest-rotation] 評価重賞数: ${evaluated}  model=${tag}\n`)
  console.log('arm             | Hit@5(1) | Hit@5(2) | G1 H@5(1)| G1 H@5(2)| 穴連対recall(人気>=8)')
  console.log('----------------|----------|----------|----------|----------|----------------------')
  console.log(row(`${tag}`, base))
  console.log(row(`${tag}+B`, withB))
  console.log(`\nダービー バステール(実3着): ${tag}=${bastailBase} / ${tag}+B=${bastailB}`)
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
