'use strict'
/**
 * MLブレンド比率のグリッドサーチ
 *
 * 使い方:
 *   node scripts/optimize_ml_blend.js
 *   node scripts/optimize_ml_blend.js --from=2025-01-01 --to=2026-05-13
 *   node scripts/optimize_ml_blend.js --limit=200
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

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  })
)

// onnxruntime-node による ML推論
let ort = null
let session = null
let featureCols = null

async function loadML() {
  try {
    ort = require('onnxruntime-node')
    const modelPath = path.join(__dirname, '..', 'ml', 'models', 'model.onnx')
    const metaPath  = path.join(__dirname, '..', 'ml', 'models', 'meta.json')
    if (!fs.existsSync(modelPath)) { console.warn('[ML] model.onnx not found'); return false }
    if (!fs.existsSync(metaPath))  { console.warn('[ML] meta.json not found');  return false }
    session = await ort.InferenceSession.create(modelPath)
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    featureCols = meta.feature_cols
    console.log(`[ML] モデル読み込み完了 (${featureCols.length}次元, AUC=${meta.test_auc?.toFixed(4)})`)
    return true
  } catch (e) {
    console.warn('[ML] 読み込み失敗:', e.message)
    return false
  }
}

async function runMLBatch(featureMatrix) {
  if (!session || !featureCols) return null
  const n = featureMatrix.length
  const flat = new Float32Array(n * featureCols.length)
  featureMatrix.forEach((row, i) => row.forEach((v, j) => { flat[i * featureCols.length + j] = v ?? 0 }))
  const tensor = new ort.Tensor('float32', flat, [n, featureCols.length])
  const res = await session.run({ input: tensor })
  const probKey = Object.keys(res).find(k => k.includes('probabilit'))
  if (!probKey) return null
  const data = res[probKey].data
  return Array.from({ length: n }, (_, i) => data[i * 2 + 1])
}

// HorseStat をキャッシュ
const horseStatCache = new Map()

async function loadHorseStats(horseNames) {
  const missing = horseNames.filter(n => !horseStatCache.has(n))
  if (missing.length > 0) {
    const rows = await prisma.horseStat.findMany({ where: { horseName: { in: missing } } })
    for (const r of rows) horseStatCache.set(r.horseName, r)
    for (const n of missing) if (!horseStatCache.has(n)) horseStatCache.set(n, null)
  }
  return horseNames.map(n => horseStatCache.get(n) ?? null)
}

// 特徴量ベクトル構築（build_dataset.py の add_feature_columns に対応）
const GRADE_RANK = { G1: 4, G2: 3, G3: 2, '通常': 1 }
const VENUE_WIN_RATE = {
  '東京': 0.119, '中山': 0.108, '阪神': 0.115, '京都': 0.114,
  '中京': 0.111, '新潟': 0.108, '札幌': 0.110, '函館': 0.109,
  '小倉': 0.110, '福島': 0.109,
}
const JOCKEY_RANKS = {
  'C.ルメール': 14, 'ルメール': 14,
  '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
  '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
  'M.デムーロ': 7, 'デムーロ': 7,
  '福永祐一': 7, '藤岡佑介': 5, '浜中俊': 5,
}
const TRAINER_RANKS = {
  '矢作芳人': 10, '国枝栄': 9, '池江泰寿': 9, '藤沢和雄': 8,
  '友道康夫': 8, '須貝尚介': 7, '音無秀孝': 7, '堀宣行': 8,
  '手塚貴久': 7, '中内田充正': 8, '高野友和': 7, '斉藤崇史': 6,
  '安田翔伍': 6, '奥村武': 5, '清水久詞': 5,
}

function getJsonRate(jsonVal, key) {
  try {
    const d = typeof jsonVal === 'string' ? JSON.parse(jsonVal) : (jsonVal ?? {})
    const v = d[String(key)]
    if (v && v.races > 0) return v.places / v.races
  } catch {}
  return null
}

function parseFormList(s, n = 5) {
  if (!s) return Array(n).fill(null)
  const parts = s.split('-').slice(0, n).map(p => { const x = parseInt(p); return isNaN(x) ? null : x })
  while (parts.length < n) parts.push(null)
  return parts
}

function buildFeatureRow(result, race, stat, oddsRank) {
  const d = new Date(race.date)
  const placeRate = stat ? (stat.totalPlaces / Math.max(stat.totalRaces, 1)) : 0.11
  const form = parseFormList(stat?.recentForm, 5)
  const formAvg = form.filter(v => v !== null).reduce((s, v) => s + v, 0) / (form.filter(v => v !== null).length || 1)
  const form3Avg = form.slice(0, 3).filter(v => v !== null).reduce((s, v) => s + v, 0) / (form.slice(0, 3).filter(v => v !== null).length || 1)
  const lastRaceDate = stat?.lastRaceDate ? new Date(stat.lastRaceDate) : null
  const daysSinceLastRaw = lastRaceDate ? Math.floor((d - lastRaceDate) / 86400000) : null
  const daysSinceLast = daysSinceLastRaw != null ? Math.min(daysSinceLastRaw, 365) : 60
  const distRate = getJsonRate(stat?.distanceData, race.distance) ?? placeRate
  const venueRate = getJsonRate(stat?.venueData, race.venue) ?? VENUE_WIN_RATE[race.venue] ?? 0.111
  const surfaceRate = getJsonRate(stat?.surfaceData, race.surface) ?? placeRate
  const courseKey = `${race.venue}-${race.surface}-${race.distance}`
  const courseDistRate = getJsonRate(stat?.courseDistData, courseKey) ?? distRate
  const avgWeight = stat?.avgHorseWeight ?? 490
  const horseWeight = result.horseWeight ?? avgWeight
  const weightChange = result.weightChange ?? 0
  const odds = result.odds ?? 15.0
  const distanceBin = race.distance <= 1400 ? 0 : race.distance <= 1700 ? 1 : race.distance <= 2100 ? 2 : 3

  return [
    GRADE_RANK[race.grade] ?? 1,
    race.surface === '芝' ? 1 : 0,
    race.distance,
    distanceBin,
    d.getMonth() + 1,
    Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000),
    stat?.totalRaces ?? 0,
    stat?.totalPlaces ?? 0,
    placeRate,
    stat?.g1Races ?? 0,
    stat?.g1Places ?? 0,
    stat?.g2Places ?? 0,
    stat?.g3Places ?? 0,
    distRate,
    venueRate,
    surfaceRate,
    courseDistRate,
    form[0] ?? formAvg,
    form[1] ?? formAvg,
    form[2] ?? formAvg,
    form[3] ?? formAvg,
    form[4] ?? formAvg,
    formAvg,
    form3Avg,
    daysSinceLast,
    stat?.lastRacePopularity ?? 9,
    JOCKEY_RANKS[result.jockey] ?? 3,
    TRAINER_RANKS[result.trainer] ?? 3,
    horseWeight,
    weightChange,
    horseWeight - avgWeight,
    result.popularity ?? 9,
    odds,
    Math.log1p(odds),
    oddsRank,
    result.rapidIncrease ?? 35.0,
  ]
}

// ヒューリスティックスコア（placeRate簡易版）
function heuristicScore(result, race, stat) {
  const placeRate = stat ? (stat.totalPlaces / Math.max(stat.totalRaces, 1)) : 0.11
  const distRate = getJsonRate(stat?.distanceData, race.distance) ?? placeRate
  const surfaceRate = getJsonRate(stat?.surfaceData, race.surface) ?? placeRate
  const score = placeRate * 0.5 + distRate * 0.25 + surfaceRate * 0.25
  const pop = result.popularity ?? 9
  const boost = Math.max(0, (10 - pop) * 0.003)
  return Math.min(score + boost, 0.99)
}

async function evaluate(races, mlWeight) {
  const heuWeight = 1 - mlWeight
  let total = 0, hit1 = 0, hit2 = 0

  for (const race of races) {
    const results = race.results.filter(r => r.finishPosition != null)
    if (results.length < 3) continue

    const horseNames = results.map(r => r.horseName)
    const stats = await loadHorseStats(horseNames)
    const statMap = new Map(horseNames.map((n, i) => [n, stats[i]]))

    const sorted = [...results].sort((a, b) => (a.odds ?? 999) - (b.odds ?? 999))
    const oddsRankMap = new Map(sorted.map((r, i) => [r.horseName, i + 1]))

    const featureMatrix = results.map(r =>
      buildFeatureRow(r, race, statMap.get(r.horseName), oddsRankMap.get(r.horseName) ?? 9)
    )

    let scores
    if (mlWeight > 0 && session) {
      const mlProbs = await runMLBatch(featureMatrix)
      if (mlProbs) {
        scores = results.map((r, i) => {
          const mlScore  = (mlProbs[i] ?? 0.11) * 100
          const heuScore = heuristicScore(r, race, statMap.get(r.horseName)) * 100
          return { horseName: r.horseName, score: mlWeight * mlScore + heuWeight * heuScore }
        })
      } else {
        scores = results.map(r => ({
          horseName: r.horseName,
          score: heuristicScore(r, race, statMap.get(r.horseName)) * 100,
        }))
      }
    } else {
      scores = results.map(r => ({
        horseName: r.horseName,
        score: heuristicScore(r, race, statMap.get(r.horseName)) * 100,
      }))
    }

    scores.sort((a, b) => b.score - a.score)
    const top5 = scores.slice(0, 5).map(s => s.horseName)
    const actual = results
      .filter(r => r.finishPosition <= 2)
      .map(r => r.horseName)

    if (actual.length < 2) continue
    total++
    const hits = actual.filter(n => top5.includes(n)).length
    if (hits >= 1) hit1++
    if (hits >= 2) hit2++
  }

  return {
    mlWeight,
    total,
    hit1,
    hit2,
    hit1Rate: total > 0 ? hit1 / total : 0,
    hit2Rate: total > 0 ? hit2 / total : 0,
  }
}

async function main() {
  const fromDate = args.from ? new Date(args.from) : new Date('2025-01-01')
  const toDate   = args.to   ? new Date(args.to)   : new Date()
  const limit    = args.limit ? parseInt(args.limit) : 300

  const mlLoaded = await loadML()

  console.log(`\n=== MLブレンド比率 グリッドサーチ ===`)
  console.log(`期間: ${fromDate.toISOString().split('T')[0]} → ${toDate.toISOString().split('T')[0]}`)
  console.log(`ML利用可能: ${mlLoaded}`)

  const races = await prisma.race.findMany({
    where: {
      date: { gte: fromDate, lte: toDate },
      results: { some: { finishPosition: { not: null } } },
    },
    include: {
      results: {
        where: { finishPosition: { not: null } },
        orderBy: { finishPosition: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
    take: limit,
  })

  console.log(`対象レース: ${races.length} 件\n`)

  const weights = mlLoaded
    ? [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    : [0.0]

  const results = []
  for (const w of weights) {
    process.stdout.write(`  ML比率 ${(w * 100).toFixed(0).padStart(3)}%  `)
    const r = await evaluate(races, w)
    results.push(r)
    process.stdout.write(`Hit@5(1)=${(r.hit1Rate * 100).toFixed(1)}%  Hit@5(2)=${(r.hit2Rate * 100).toFixed(1)}%  [${r.total}件]\n`)
  }

  // 最適比率を探す（Hit@5(2)優先、同点はHit@5(1)）
  const best = results.reduce((b, r) =>
    r.hit2Rate > b.hit2Rate || (r.hit2Rate === b.hit2Rate && r.hit1Rate > b.hit1Rate) ? r : b
  )

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`最適 ML比率: ${(best.mlWeight * 100).toFixed(0)}%`)
  console.log(`  Hit@5(1): ${(best.hit1Rate * 100).toFixed(1)}%`)
  console.log(`  Hit@5(2): ${(best.hit2Rate * 100).toFixed(1)}%`)
  console.log(`  件数: ${best.total}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (best.mlWeight !== 0.7) {
    console.log(`\n[推奨] predict/route.ts の ML_WEIGHT を ${best.mlWeight.toFixed(1)} に変更してください。`)
    console.log(`  const ML_WEIGHT = ${best.mlWeight.toFixed(1)}`)
    console.log(`  const HEU_WEIGHT = ${(1 - best.mlWeight).toFixed(1)}`)
  } else {
    console.log('\n[OK] 現在の 0.7/0.3 が最適です。')
  }

  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
