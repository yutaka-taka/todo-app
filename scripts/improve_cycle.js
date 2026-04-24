'use strict'
/**
 * 自律改善サイクル: 予想削除→再予想→精度分析→アルゴリズム改善
 * Claude APIなし。localAutoLearn互換のweightsを使用。
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')

function loadEnv(file) {
  try {
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()

// ===== スコアリングエンジン（scorer.tsと同期）=====
const DEFAULT_WEIGHTS = {
  recentFormMult: 0.58, // 自己学習・座標降下最適化済み(v259)
  distanceMult: 1.28,   // 距離適性：最強因子
  venueMult: 1.15,      // コース適性：第2因子
  surfaceMult: 1.05,
  g1Mult: 0.85,         // G1実績：過剰評価抑制
  ageMult: 0.40,        // 年齢：補助的因子（最低値）
  jockeyMult: 0.95,
  raceAffinityMult: 1.0, // 同一レース相性
}

// 騎手ランク定義
const JOCKEY_RANKS = {
  'C.ルメール': 14, 'ルメール': 14,
  '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
  '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
  'M.デムーロ': 7, 'デムーロ': 7,
  '浜中俊': 4, '田辺裕信': 4, '丸山元気': 4,
  '幸英明': 4, '藤岡佑介': 4, '西村淳也': 4,
  '鮫島克駿': 4, '永野猛蔵': 4, '三浦皇成': 4,
  '福永祐一': 7, '岩田康誠': 4, '蛯名正義': 4,
  '内田博幸': 4, '柴田善臣': 4,
}

const RANK_CAPS = [65, 52, 38, 28, 22, 18, 15]

function buildScore(entry, race, stat, weights) {
  if (!stat || stat.totalRaces === 0) return { score: 30, bonuses: {} }
  const laplaceBase = (stat.totalPlaces + 2) / (stat.totalRaces + 8) * 100
  // G1レースの場合G1実績をブレンド（1レースから適用）
  let effectiveBase = laplaceBase
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Rate = (stat.g1Places + 2) / (stat.g1Races + 8) * 100
    const gw = Math.min(stat.g1Races, 10) / 10 * 0.6
    effectiveBase = laplaceBase * (1 - gw) + g1Rate * gw
  }
  effectiveBase = Math.min(effectiveBase, 60)
  const bonuses = {}

  // G1実績
  let g1Bonus = 0
  if (race.grade === 'G1' || race.grade === 'G2') {
    if (stat.g1Races === 0) {
      const overallRate = stat.totalPlaces / stat.totalRaces
      g1Bonus = overallRate >= 0.45 ? -3 : overallRate >= 0.30 ? -5 : -8
    } else {
      const r = stat.g1Places / stat.g1Races
      if (r >= 0.4) g1Bonus = 18
      else if (r >= 0.2) g1Bonus = 8
      else if (stat.g1Races >= 3) g1Bonus = -8
      else g1Bonus = -3
    }
  }
  bonuses.g1 = g1Bonus * (weights.g1Mult || 1)

  // 距離適性
  let distBonus = 0
  const distData = (stat.distanceData && typeof stat.distanceData === 'object') ? stat.distanceData : {}
  const dk = String(race.distance)
  if (distData[dk] && distData[dk].races > 0) {
    const sf = Math.min(distData[dk].races, 5) / 5
    const r = distData[dk].places / distData[dk].races
    if (r >= 0.5) distBonus = Math.round(15 * sf)
    else if (r >= 0.3) distBonus = Math.round(7 * sf)
    else distBonus = -Math.round(5 * sf)
  }
  bonuses.distance = distBonus * (weights.distanceMult || 1)

  // 競馬場適性
  let venueBonus = 0
  const venueData = (stat.venueData && typeof stat.venueData === 'object') ? stat.venueData : {}
  if (venueData[race.venue] && venueData[race.venue].races > 0) {
    const sf = Math.min(venueData[race.venue].races, 5) / 5
    const r = venueData[race.venue].places / venueData[race.venue].races
    if (r >= 0.4) venueBonus = Math.round(10 * sf)
    else if (r >= 0.2) venueBonus = Math.round(3 * sf)
    else venueBonus = -Math.round(3 * sf)
  }
  bonuses.venue = venueBonus * (weights.venueMult || 1)

  // 馬場適性
  let surfBonus = 0
  const surfData = (stat.surfaceData && typeof stat.surfaceData === 'object') ? stat.surfaceData : {}
  if (surfData[race.surface] && surfData[race.surface].races > 0) {
    const sf = Math.min(surfData[race.surface].races, 8) / 8
    const r = surfData[race.surface].places / surfData[race.surface].races
    if (r >= 0.5) surfBonus = Math.round(8 * sf)
    else if (r < 0.2) surfBonus = -Math.round(8 * sf)
  }
  bonuses.surface = surfBonus * (weights.surfaceMult || 1)

  // 直近フォーム
  let formBonus = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length > 0) {
      const ws = [0.40, 0.25, 0.18, 0.12, 0.05]
      let s = 0, t = 0
      for (let i = 0; i < Math.min(pos.length, 5); i++) { s += pos[i] * ws[i]; t += ws[i] }
      const avg = s / t
      if (avg <= 1.4) formBonus = 24
      else if (avg <= 1.8) formBonus = 20
      else if (avg <= 2.2) formBonus = 15
      else if (avg <= 3.0) formBonus = 8
      else if (avg <= 4.5) formBonus = 1
      else if (avg > 7) formBonus = -10
      else formBonus = -4
      // 直近2戦連続連対ボーナス
      if (pos.length >= 2 && pos[0] <= 2 && pos[1] <= 2) formBonus += 5
      // 直近1戦1着ボーナス
      if (pos[0] === 1) formBonus += 3
    }
  }
  bonuses.recentForm = formBonus * (weights.recentFormMult || 1)

  // 年齢補正
  let ageBonus = 0
  const age = entry.age ? Number(entry.age) : 0
  if (age === 3) ageBonus = 3
  else if (age === 4 || age === 5) ageBonus = 2
  else if (age >= 7) ageBonus = -4
  bonuses.age = ageBonus * (weights.ageMult || 1)

  // 騎手評価
  let jockeyBonus = 0
  if (entry.jockey) {
    jockeyBonus = JOCKEY_RANKS[entry.jockey] ?? 0
  }
  bonuses.jockey = jockeyBonus * (weights.jockeyMult || 1)

  // 同一レース相性ボーナス
  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const raceKey = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rnData = stat.raceNameData[raceKey]
    if (rnData && rnData.races > 0) {
      if (rnData.places >= 2)      raceAffinityBonus = 18
      else if (rnData.places >= 1) raceAffinityBonus = 6
      else if (rnData.races >= 3)  raceAffinityBonus = -4
    }
  }
  bonuses.raceAffinity = raceAffinityBonus * (weights.raceAffinityMult || 1)

  // 少数レース高ポテンシャル補正（出走数≤6でG1連対実績あり → 有望馬）
  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    const g1Rate = stat.g1Places / stat.g1Races
    potentialBonus = g1Rate >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5  // G1実績なくても少数戦で好成績
  }
  bonuses.potential = potentialBonus

  // 直近フォームのトレンド補正（改善中ならボーナス）
  let trendBonus = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length >= 4) {
      const recentAvg = (pos[0] + pos[1]) / 2
      const olderAvg = (pos[2] + pos[3]) / 2
      if (recentAvg < olderAvg - 1.5) trendBonus = 6   // 急上昇中
      else if (recentAvg < olderAvg - 0.5) trendBonus = 3  // 改善中
      else if (recentAvg > olderAvg + 2) trendBonus = -5   // 急降下
    }
  }
  bonuses.trend = trendBonus

  const totalBonus = Object.values(bonuses).reduce((a, b) => a + b, 0)
  const raw = effectiveBase + totalBonus
  // 72上限はソート後にランクキャップで適用するため、ここでは下限のみ
  const score = Math.round(Math.max(20, raw) * 10) / 10
  return { score, bonuses }
}

function applyRankCaps(scored) {
  for (let i = 0; i < scored.length; i++) {
    const cap = RANK_CAPS[i] ?? 18
    scored[i].placeRate = Math.min(scored[i].placeRate, cap)
  }
  // 差別化ペナルティ
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 5) {
    scored[1].placeRate = Math.max(scored[1].placeRate - 7, (RANK_CAPS[1] ?? 52) - 12)
  }
  if (scored.length >= 3 && scored[1].placeRate - scored[2].placeRate < 5) {
    scored[2].placeRate = Math.max(scored[2].placeRate - 12, (RANK_CAPS[2] ?? 38) - 14)
  }
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 1) {
    scored[0].placeRate = Math.max(scored[0].placeRate - 5, scored[1].placeRate + 2)
  }
  return scored
}

function scoreAllHorses(entries, race, statMap, weights) {
  const scored = entries.map(e => {
    const stat = statMap.get(e.horseName) || null
    const { score, bonuses } = buildScore(e, race, stat, weights)
    return { ...e, placeRate: score, _bonuses: bonuses }
  }).sort((a, b) => b.placeRate - a.placeRate)

  const top7 = applyRankCaps(scored.slice(0, 7))
  return top7.map((h, i) => ({ ...h, rank: i + 1 }))
}

// ===== 精度計算 =====
function calcAccuracy(races) {
  let full = 0, half = 0, miss = 0
  const rankHits = { 1: { a: 0, h: 0 }, 2: { a: 0, h: 0 }, 3: { a: 0, h: 0 }, 4: { a: 0, h: 0 }, 5: { a: 0, h: 0 }, 6: { a: 0, h: 0 }, 7: { a: 0, h: 0 } }
  const factorSamples = { recentForm: [], distance: [], venue: [], surface: [], g1: [], age: [], raceAffinity: [] }
  const missDetails = []

  for (const r of races) {
    const top7 = r.predictions.slice(0, 7).map(p => p.horseName)
    const actual = r.results.filter(x => x.finishPosition <= 2).map(x => x.horseName)
    if (actual.length < 2) continue

    const hits = actual.filter(a => top7.includes(a)).length
    if (hits === 2) full++
    else if (hits === 1) half++
    else miss++

    for (const pred of r.predictions.slice(0, 7)) {
      if (rankHits[pred.rank]) {
        rankHits[pred.rank].a++
        if (actual.includes(pred.horseName)) rankHits[pred.rank].h++
      }
      // ファクター精度サンプル収集
      const fac = (pred.factors && pred.factors._bonuses) ? pred.factors._bonuses : null
      if (fac) {
        const hit = actual.includes(pred.horseName)
        for (const [key, val] of Object.entries(fac)) {
          if (factorSamples[key]) factorSamples[key].push({ val, hit })
        }
      }
    }

    if (hits < 2) {
      const surprises = actual.filter(a => !top7.includes(a))
      missDetails.push({
        name: r.name,
        grade: r.grade,
        predicted: r.predictions.slice(0, 3).map(p => `${p.horseName}(${p.placeRate}%)`).join('/'),
        actual: actual.join('/'),
        surprises,
      })
    }
  }

  const total = full + half + miss
  const accuracy = total > 0 ? Math.round((full * 2 + half) / (total * 2) * 1000) / 10 : 0
  return { total, accuracy, full, half, miss, rankHits, factorSamples, missDetails }
}

// ===== ウェイト調整 =====
function nudgeWeights(factorSamples, currentWeights) {
  const newWeights = { ...currentWeights }
  const report = []

  for (const [key, samples] of Object.entries(factorSamples)) {
    if (samples.length < 5) continue
    const positiveHits = samples.filter(s => s.val > 0 && s.hit).length
    const positiveTotal = samples.filter(s => s.val > 0).length
    const negativeHits = samples.filter(s => s.val < 0 && s.hit).length
    const negativeTotal = samples.filter(s => s.val < 0).length

    if (positiveTotal >= 5) {
      const posRate = positiveHits / positiveTotal
      const mult = key + 'Mult'
      if (posRate > 0.58) {
        newWeights[mult] = Math.min(1.8, (currentWeights[mult] || 1) + 0.08)
        report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → 乗数UP ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
      } else if (posRate < 0.35) {
        newWeights[mult] = Math.max(0.4, (currentWeights[mult] || 1) - 0.08)
        report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → 乗数DOWN ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
      }
    }
  }

  return { newWeights, report }
}

async function main() {
  console.log('=== 自律精度改善サイクル ===\n')

  // 現在のウェイト取得
  const currentAlgo = await prisma.algorithmConfig.findFirst({ orderBy: { version: 'desc' } })
  let currentWeights = { ...DEFAULT_WEIGHTS }
  if (currentAlgo?.insights) {
    try {
      const ins = JSON.parse(currentAlgo.insights)
      if (ins.localWeights) currentWeights = { ...DEFAULT_WEIGHTS, ...ins.localWeights }
    } catch {}
  }
  console.log('現在のウェイト:', JSON.stringify(currentWeights))
  console.log('現在のアルゴリズムバージョン:', currentAlgo?.version || 0)

  // ====== Step 1: 古い予想を削除して再予想 ======
  console.log('\n--- Step 1: 古い予想を削除して再予想 ---')

  // G1のみ再予想（G2/G3は学習データとして使うが予想はG1のみ）
  const oldPredRaces = await prisma.race.findMany({
    where: { grade: 'G1', date: { lt: new Date() }, predictions: { some: {} }, results: { some: { finishPosition: { lte: 2 } } } },
    include: {
      predictions: { orderBy: { rank: 'asc' }, take: 1 },
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
  })

  // 古い予想 = スコアが65超 or _bonusesがない
  const racesToRepredict = oldPredRaces.filter(r => {
    const topPred = r.predictions[0]
    if (!topPred) return false
    const hasBonuses = topPred.factors && typeof topPred.factors === 'object' && '_bonuses' in topPred.factors
    return (topPred.placeRate > 65) || !hasBonuses
  })

  console.log(`再予想対象: ${racesToRepredict.length}/${oldPredRaces.length}レース`)

  let repredicted = 0
  for (const race of racesToRepredict) {
    // 古い予想を削除
    await prisma.prediction.deleteMany({ where: { raceId: race.id } })

    // エントリー補完: entries + resultsの馬を合わせてスコアリング
    const entryNames = new Set(race.entries.map(e => e.horseName))
    const additionalFromResults = race.results
      .filter(r => !entryNames.has(r.horseName))
      .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
    const rawEntries = [...race.entries, ...additionalFromResults]
    if (rawEntries.length === 0) continue

    const horseNames = rawEntries.map(e => e.horseName)
    const stats = await prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } })
    const statMap = new Map(stats.map(s => [s.horseName, s]))

    const scored = scoreAllHorses(rawEntries, race, statMap, currentWeights)
    if (scored.length === 0) continue

    await prisma.prediction.createMany({
      data: scored.map(p => ({
        raceId: race.id,
        horseNumber: p.horseNumber,
        horseName: p.horseName,
        placeRate: p.placeRate,
        rank: p.rank,
        factors: { _bonuses: p._bonuses },
      }))
    })
    repredicted++
  }

  // G1で予想のないレースを予想（G2/G3は除外）
  const unpredictedRaces = await prisma.race.findMany({
    where: {
      grade: 'G1',
      date: { lt: new Date() },
      results: { some: { finishPosition: { lte: 2 } } },
      predictions: { none: {} },
    },
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
  })

  console.log(`新規予想対象: ${unpredictedRaces.length}レース`)

  for (const race of unpredictedRaces) {
    // エントリー補完: entries + resultsの馬を合わせてスコアリング
    const entryNames2 = new Set(race.entries.map(e => e.horseName))
    const additionalFromResults2 = race.results
      .filter(r => !entryNames2.has(r.horseName))
      .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
    const rawEntries = [...race.entries, ...additionalFromResults2]
    if (rawEntries.length === 0) continue

    const horseNames = rawEntries.map(e => e.horseName)
    const stats = await prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } })
    const statMap = new Map(stats.map(s => [s.horseName, s]))

    const scored = scoreAllHorses(rawEntries, race, statMap, currentWeights)
    if (scored.length === 0) continue

    await prisma.prediction.createMany({
      data: scored.map(p => ({
        raceId: race.id,
        horseNumber: p.horseNumber,
        horseName: p.horseName,
        placeRate: p.placeRate,
        rank: p.rank,
        factors: { _bonuses: p._bonuses },
      }))
    })
    repredicted++
  }

  console.log(`再予想完了: ${repredicted}レース`)

  // ====== Step 2: 精度測定 ======
  console.log('\n--- Step 2: 精度測定 ---')
  const racesWithBoth = await prisma.race.findMany({
    where: { grade: 'G1', predictions: { some: {} }, results: { some: { finishPosition: { lte: 2 } } } },
    include: {
      predictions: { orderBy: { rank: 'asc' }, take: 6 },
      results: { where: { finishPosition: { lte: 2 } }, orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  const stats1 = calcAccuracy(racesWithBoth)
  console.log(`照合レース数: ${stats1.total}`)
  console.log(`通算的中率: ${stats1.accuracy}%`)
  console.log(`完全的中: ${stats1.full} / 半的中: ${stats1.half} / 外れ: ${stats1.miss}`)
  console.log('\n予想順位別的中率:')
  for (const [rank, v] of Object.entries(stats1.rankHits)) {
    if (v.a > 0) console.log(`  ${rank}位: ${v.h}/${v.a}回 (${Math.round(v.h / v.a * 100)}%)`)
  }

  // ====== Step 3: 外れパターン分析 ======
  console.log('\n--- Step 3: 外れパターン分析 ---')
  const misses = stats1.missDetails

  // G1/G2別の分析
  const g1Misses = misses.filter(m => m.grade === 'G1')
  const g2Misses = misses.filter(m => m.grade === 'G2')
  const g3Misses = misses.filter(m => m.grade === 'G3')
  console.log(`外れ内訳: G1=${g1Misses.length} G2=${g2Misses.length} G3=${g3Misses.length}`)

  // サプライズ馬の特徴分析
  const surpriseHorses = misses.flatMap(m => m.surprises)
  const surpriseStats = await prisma.horseStat.findMany({ where: { horseName: { in: surpriseHorses } } })
  const surpriseStatMap = new Map(surpriseStats.map(s => [s.horseName, s]))

  let surpriseNoData = 0, surpriseLowRate = 0, surpriseHighRate = 0
  for (const name of surpriseHorses) {
    const s = surpriseStatMap.get(name)
    if (!s) surpriseNoData++
    else {
      const rate = s.totalPlaces / s.totalRaces
      if (rate < 0.3) surpriseLowRate++
      else surpriseHighRate++
    }
  }
  console.log(`\n見落としたサプライズ馬 ${surpriseHorses.length}頭:`)
  console.log(`  データなし: ${surpriseNoData}頭`)
  console.log(`  低連対率(<30%): ${surpriseLowRate}頭`)
  console.log(`  高連対率(≥30%): ${surpriseHighRate}頭`)

  // 外れ詳細（上位8件）
  console.log('\n代表的な外れパターン:')
  misses.slice(0, 8).forEach(m => {
    console.log(`  [${m.grade}]${m.name}: 予想[${m.predicted}] 実際[${m.actual}]`)
  })

  // ====== Step 4: ウェイト調整 ======
  console.log('\n--- Step 4: ウェイト自動調整 ---')
  const { newWeights, report: weightReport } = nudgeWeights(stats1.factorSamples, currentWeights)
  if (weightReport.length > 0) {
    weightReport.forEach(r => console.log(r))
  } else {
    console.log('  ウェイト調整なし（サンプル不足またはバランス良好）')
  }

  // ====== Step 5: アルゴリズム改善ルール生成 ======
  console.log('\n--- Step 5: アルゴリズム改善ルール生成 ---')

  const improvements = []

  // サプライズ馬対策
  if (surpriseNoData > surpriseHorses.length * 0.4) {
    improvements.push(`データなしの馬への初期スコアを28→32に引き上げ。HorseStatのない馬も実力馬の可能性があるため基準スコアを上昇。`)
  }
  if (surpriseLowRate > 3) {
    improvements.push(`低連対率馬（<30%）が頻繁に連対。G1でのペナルティ基準を見直し、レース距離適性や馬場適性の重みを増加。`)
  }

  // 順位別精度
  const r1Rate = stats1.rankHits[1].a > 0 ? stats1.rankHits[1].h / stats1.rankHits[1].a : 0
  const r2Rate = stats1.rankHits[2].a > 0 ? stats1.rankHits[2].h / stats1.rankHits[2].a : 0
  if (r1Rate < 0.55) {
    improvements.push(`1位予想の的中率${Math.round(r1Rate*100)}%が低い。スコア上位馬の差別化強化：トップ馬への追加ボーナス+3点。`)
  }
  if (r2Rate < 0.45) {
    improvements.push(`2位予想の的中率${Math.round(r2Rate*100)}%が低い。2番手馬への差別化ペナルティを緩和し、対抗馬の評価精度向上。`)
  }

  // G1穴馬対策
  if (g1Misses.length > stats1.miss * 0.5) {
    improvements.push(`G1での外れ${g1Misses.length}/${stats1.miss}件が多い。G1初参戦馬への過剰ペナルティを軽減：総連対率≥40%の場合は-3点に抑制。`)
  }

  // フォーム重視
  if (stats1.factorSamples.recentForm.length > 0) {
    const rfPositive = stats1.factorSamples.recentForm.filter(s => s.val > 0)
    const rfHitRate = rfPositive.filter(s => s.hit).length / Math.max(rfPositive.length, 1)
    if (rfHitRate > 0.6) {
      improvements.push(`直近フォームボーナスの命中率${Math.round(rfHitRate*100)}%が高い。recentFormMultを+0.1上昇させ直近好調馬を重視。`)
      newWeights.recentFormMult = Math.min(1.8, newWeights.recentFormMult + 0.1)
    }
  }

  console.log('改善ポイント:')
  improvements.forEach((imp, i) => console.log(`  ${i+1}. ${imp}`))

  // ====== Step 6: AlgorithmConfig更新 ======
  console.log('\n--- Step 6: AlgorithmConfig更新 ---')
  const newVersion = (currentAlgo?.version || 230) + 1
  const localAccuracy = { total: stats1.total, accuracy: stats1.accuracy }

  await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
  await prisma.algorithmConfig.create({
    data: {
      version: newVersion,
      isActive: true,
      rules: improvements.join('\n'),
      insights: JSON.stringify({
        localWeights: newWeights,
        localAccuracy,
        lastLearnedAt: new Date().toISOString(),
        improvementNotes: improvements,
      }),
      analyzedCount: stats1.total,
      accuracy: stats1.accuracy,
    }
  })

  console.log(`AlgorithmConfig v${newVersion}に更新`)
  console.log(`精度: ${stats1.accuracy}% (${stats1.total}レース)`)
  console.log('新しいウェイト:', JSON.stringify(newWeights))

  // ====== Step 7: 改善後の再予想 & 精度確認 ======
  if (JSON.stringify(newWeights) !== JSON.stringify(currentWeights)) {
    console.log('\n--- Step 7: 改善ウェイトで再予想 ---')

    const allRaces = await prisma.race.findMany({
      where: { grade: 'G1', date: { lt: new Date() }, results: { some: { finishPosition: { lte: 2 } } } },
      include: {
        entries: { orderBy: { horseNumber: 'asc' } },
        results: { orderBy: { finishPosition: 'asc' } },
      },
    })

    let improved = 0
    for (const race of allRaces) {
      const entryNamesS7 = new Set(race.entries.map(e => e.horseName))
      const addFromResultsS7 = race.results
        .filter(r => !entryNamesS7.has(r.horseName))
        .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
      const rawEntries = [...race.entries, ...addFromResultsS7]
      if (rawEntries.length === 0) continue

      await prisma.prediction.deleteMany({ where: { raceId: race.id } })

      const horseNames = rawEntries.map(e => e.horseName)
      const stats = await prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } })
      const statMap = new Map(stats.map(s => [s.horseName, s]))

      const scored = scoreAllHorses(rawEntries, race, statMap, newWeights)
      if (scored.length === 0) continue

      await prisma.prediction.createMany({
        data: scored.map(p => ({
          raceId: race.id,
          horseNumber: p.horseNumber,
          horseName: p.horseName,
          placeRate: p.placeRate,
          rank: p.rank,
          factors: { _bonuses: p._bonuses },
        }))
      })
      improved++
    }

    // 改善後の精度確認
    const racesAfter = await prisma.race.findMany({
      where: { grade: 'G1', predictions: { some: {} }, results: { some: { finishPosition: { lte: 2 } } } },
      include: {
        predictions: { orderBy: { rank: 'asc' }, take: 6 },
        results: { where: { finishPosition: { lte: 2 } }, orderBy: { finishPosition: 'asc' } },
      },
    })

    const stats2 = calcAccuracy(racesAfter)
    console.log(`改善後の精度: ${stats2.accuracy}% (${stats2.total}レース)`)
    console.log(`完全的中: ${stats2.full} / 半的中: ${stats2.half} / 外れ: ${stats2.miss}`)
    console.log(`精度変化: ${stats1.accuracy}% → ${stats2.accuracy}% (${stats2.accuracy >= stats1.accuracy ? '+' : ''}${Math.round((stats2.accuracy - stats1.accuracy) * 10) / 10}%)`)

    // 精度が改善していたら最終バージョンに保存
    if (stats2.accuracy > stats1.accuracy) {
      await prisma.algorithmConfig.updateMany({ where: { version: newVersion }, data: {
        accuracy: stats2.accuracy,
        insights: JSON.stringify({
          localWeights: newWeights,
          localAccuracy: { total: stats2.total, accuracy: stats2.accuracy },
          lastLearnedAt: new Date().toISOString(),
          improvementNotes: improvements,
        }),
      }})
      console.log(`→ 精度向上確認。v${newVersion}に最終保存。`)
    } else {
      console.log(`→ 精度変化なしまたは低下。ウェイトは記録に残すが使用を再検討。`)
    }
  } else {
    console.log('\nStep 7スキップ（ウェイト変更なし）')
  }

  console.log('\n=== 自律改善サイクル完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('エラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
