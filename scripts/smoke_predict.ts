/**
 * E2E スモークテスト: 本番 serving の計算（localScoreHorses + ML mlBlend）を実レースで実行し、
 * 表示用フィールド（連対率 / _mlRate / _heuristicRate / 選定理由）が正しく出るか目視確認する。
 *
 *   npx tsx scripts/smoke_predict.ts                 # 直近のG1
 *   npx tsx scripts/smoke_predict.ts --name=天皇賞
 */
import { PrismaClient, type HorseStat } from '@prisma/client'
import { localScoreHorses, DEFAULT_WEIGHTS } from '../src/lib/scorer'
import { buildMLFeatures } from '../src/lib/mlFeatures'
import { predictML, isMLModelAvailable, getMLMeta } from '../src/lib/mlInference'

const prisma = new PrismaClient()
const argv = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true] }))

async function main() {
  console.log(`[smoke] ML available: ${isMLModelAvailable()}  AUC=${getMLMeta()?.test_auc?.toFixed(4)}  ML_BLEND_RATIO=${process.env.ML_BLEND_RATIO ?? '0.8(default)'}`)
  const where: Record<string, unknown> = { grade: 'G1', results: { some: { finishPosition: { not: null } } } }
  if (argv.name) where.name = { contains: argv.name as string }
  const race = await prisma.race.findFirst({
    where, orderBy: { date: 'desc' },
    include: { results: { where: { finishPosition: { not: null } }, orderBy: { finishPosition: 'asc' } } },
  })
  if (!race) { console.log('該当レースなし'); await prisma.$disconnect(); return }
  console.log(`\n=== ${race.name} (${race.grade}) ${new Date(race.date).toISOString().slice(0, 10)} ${race.venue} ${race.surface}${race.distance}m ===`)

  const entries = race.results.map(r => ({
    horseNumber: r.horseNumber, horseName: r.horseName, age: r.age ?? null,
    jockey: r.jockey ?? null, trainer: r.trainer ?? null,
    horseWeight: r.horseWeight ?? null, weightChange: r.weightChange ?? null,
    frameNumber: null as number | null, lastThreeFurlong: null as number | null, runningStyle: null as string | null,
    oddsPopularity: r.popularity ?? null, oddsFloat: r.odds ?? null,
  }))
  const names = entries.map(e => e.horseName)
  const stats = await prisma.horseStat.findMany({ where: { horseName: { in: names } } }) as HorseStat[]
  const statMap = new Map(stats.map(s => [s.horseName, s]))
  const raceCtx = { name: race.name, grade: race.grade, distance: race.distance, venue: race.venue, surface: race.surface, trackCondition: race.trackCondition ?? undefined, date: new Date(race.date) }

  let mlRateMap: Map<string, number> | null = null
  if (isMLModelAvailable()) {
    const inputs = entries.map(e => buildMLFeatures({ ...e }, raceCtx, statMap.get(e.horseName) ?? null))
    const probs = await predictML(inputs)
    if (probs) mlRateMap = new Map(entries.map((e, i) => [e.horseName, (probs[i] ?? 0.11) * 100]))
  }
  const ratio = Math.max(0, Math.min(1, parseFloat(process.env.ML_BLEND_RATIO ?? '0.9')))
  const scored = localScoreHorses(entries, raceCtx, stats, DEFAULT_WEIGHTS, {
    selectionMode: 'multiaxis', mlBlend: mlRateMap ? { mlRateMap, mlWeight: ratio } : undefined,
  })

  const actual = race.results.filter(r => (r.finishPosition ?? 99) <= 2).map(r => `${r.horseNumber}${r.horseName}`)
  console.log('\n予測 top5 (連対率 = ML×0.9 + ヒューリスティック×0.1):')
  scored.forEach(s => console.log(
    `  ${s.rank}. ${String(s.horseNumber).padStart(2)} ${s.horseName.padEnd(12)} 連対率=${s.placeRate}%  [ML=${s._mlRate ?? '-'} / 旧=${s._heuristicRate ?? '-'}]  理由=${s._selectionReason}`
  ))
  console.log(`\n実際の連対馬: ${actual.join(' / ')}`)
  const top5names = scored.map(s => s.horseName)
  const hits = race.results.filter(r => (r.finishPosition ?? 99) <= 2 && top5names.includes(r.horseName)).length
  console.log(`Hit@5: ${hits}/2 ${hits >= 2 ? '◎' : hits >= 1 ? '○' : '×'}  ※現行HorseStatは当該レース結果を含むため参考値（honest値はbacktest参照）`)
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
