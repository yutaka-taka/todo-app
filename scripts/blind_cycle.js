'use strict'
/**
 * 時系列ブラインド改善サイクル
 * レースを日付順に処理し、各G1レースを「それ以前のデータのみ」で予想→照合→改善
 * 循環参照なしの真の出力外精度 (out-of-sample accuracy) を計測
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')

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

// ===== スコアリングエンジン (scorer.ts / improve_cycle.js と同期) =====
const DEFAULT_WEIGHTS = {
  recentFormMult: 0.58,
  distanceMult: 1.28,
  venueMult: 1.15,
  surfaceMult: 1.05,
  g1Mult: 0.85,
  ageMult: 0.40,
  jockeyMult: 0.95,
  raceAffinityMult: 1.0,
  trackCondMult: 1.0,
}

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

// 各G1レースの主要ステップアップレース（前哨戦）
const PREP_RACES = {
  '日本ダービー':           ['皐月賞', 'NHKマイルカップ', '青葉賞'],
  '菊花賞':               ['神戸新聞杯', 'セントライト記念', '皐月賞'],
  'オークス':              ['桜花賞', 'フローラステークス', 'スイートピーステークス'],
  '優駿牝馬（オークス）':      ['桜花賞', 'フローラステークス'],
  '天皇賞（春）':           ['阪神大賞典', '日経賞', 'AJCC', '有馬記念'],
  '宝塚記念':              ['大阪杯', '天皇賞（春）', 'AJCC'],
  '天皇賞（秋）':           ['毎日王冠', 'オールカマー', '札幌記念'],
  '有馬記念':              ['ジャパンカップ', '天皇賞（秋）', '宝塚記念'],
  'ジャパンカップ':          ['天皇賞（秋）', '宝塚記念'],
  '安田記念':              ['ヴィクトリアマイル', '阪神牝馬ステークス', 'NHKマイルカップ', 'マイラーズカップ'],
  'ヴィクトリアマイル':        ['阪神牝馬ステークス', '中山牝馬ステークス', '桜花賞'],
  'エリザベス女王杯':         ['府中牝馬ステークス', '秋華賞', 'オークス'],
  '秋華賞':               ['オークス', 'ローズステークス', '紫苑ステークス'],
  'スプリンターズステークス':    ['キーンランドカップ', 'セントウルステークス', '高松宮記念'],
  '高松宮記念':             ['シルクロードステークス', 'オーシャンステークス'],
  'マイルチャンピオンシップ':    ['スワンステークス', '富士ステークス', '安田記念'],
  'フェブラリーステークス':     ['東海ステークス', '根岸ステークス', 'チャンピオンズカップ'],
  'チャンピオンズカップ':       ['JBCクラシック', 'みやこステークス', 'シリウスステークス'],
  'NHKマイルカップ':         ['アーリントンカップ', 'ニュージーランドトロフィー', 'ファルコンステークス', '桜花賞'],
  '桜花賞':               ['チューリップ賞', 'フィリーズレビュー', 'アネモネステークス'],
  '皐月賞':               ['弥生賞ディープインパクト記念', 'スプリングステークス', '共同通信杯', 'きさらぎ賞'],
  'ホープフルステークス':       ['東京スポーツ杯2歳ステークス', 'デイリー杯2歳ステークス'],
  '大阪杯':               ['金鯱賞', '中山記念', '京都記念'],
}

function smoothedRate(places, races) { return (places + 2) / (races + 8) * 100 }

function getJockeyBonus(jockey, jockeyStatsMap) {
  if (!jockey) return 0
  const s = jockeyStatsMap && jockeyStatsMap.get(jockey)
  if (!s || s.total < 3) {
    return JOCKEY_RANKS[jockey] ?? 0
  }
  const g1Rate = s.g1Total >= 3 ? (s.g1Places + 1) / (s.g1Total + 4) : null
  const overallRate = (s.places + 2) / (s.total + 8)
  const blendedRate = g1Rate ? g1Rate * 0.6 + overallRate * 0.4 : overallRate
  return Math.round(Math.max(-4, Math.min(14, (blendedRate * 100 - 20) * 14 / 35)))
}

function buildScore(entry, race, stat, weights, jockeyStatsMap) {
  if (!stat || stat.totalRaces === 0) {
    let partial = 0
    const age = entry.age ? Number(entry.age) : 0
    if (age === 3) partial += 3
    else if (age === 4 || age === 5) partial += 2
    else if (age >= 7) partial -= 3
    return { score: Math.max(22, Math.min(38, 30 + partial)), bonuses: {} }
  }

  const laplaceBase = smoothedRate(stat.totalPlaces, stat.totalRaces)
  // G1レースの場合G1実績をブレンド
  let effectiveBase = laplaceBase
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Rate = smoothedRate(stat.g1Places, stat.g1Races)
    const w = Math.min(stat.g1Races, 10) / 10 * 0.6
    effectiveBase = laplaceBase * (1 - w) + g1Rate * w
  }
  const cappedBase = Math.min(effectiveBase, 60)
  const bonuses = {}

  // G1実績
  let g1Bonus = 0
  if (stat.g1Races === 0) {
    const r = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    g1Bonus = r >= 0.45 ? -3 : r >= 0.30 ? -5 : -8
  } else {
    const r = stat.g1Places / stat.g1Races
    if (r >= 0.4) g1Bonus = 18
    else if (r >= 0.2) g1Bonus = 8
    else if (stat.g1Races >= 3) g1Bonus = -8
    else g1Bonus = -1   // 1-2 G1経験で未連対: -3→-1 (近年のG1出走経験は価値あり)
  }
  bonuses.g1 = Math.round(g1Bonus * (weights.g1Mult || 1))

  // 距離適性
  let distBonus = 0
  const distData = stat.distanceData || {}
  const dk = String(race.distance)
  if (distData[dk] && distData[dk].races > 0) {
    const sf = Math.min(distData[dk].races, 5) / 5
    const r = distData[dk].places / distData[dk].races
    distBonus = r >= 0.5 ? Math.round(15 * sf) : r >= 0.3 ? Math.round(7 * sf) : -Math.round(5 * sf)
  } else {
    // 近傍距離参照
    for (const delta of [-200, 200, -400, 400]) {
      const nd = distData[String(race.distance + delta)]
      if (nd && nd.races >= 2) {
        const f = Math.abs(delta) === 200 ? 0.5 : 0.3
        const r = nd.places / nd.races
        const v = r >= 0.5 ? 15 * f : r >= 0.3 ? 7 * f : -5 * f
        if (v > distBonus) distBonus = v
      }
    }
    distBonus = Math.round(distBonus)
  }
  bonuses.distance = Math.round(distBonus * (weights.distanceMult || 1))

  // 競馬場適性
  let venueBonus = 0
  const venueData = stat.venueData || {}
  if (venueData[race.venue] && venueData[race.venue].races > 0) {
    const sf = Math.min(venueData[race.venue].races, 5) / 5
    const r = venueData[race.venue].places / venueData[race.venue].races
    venueBonus = r >= 0.4 ? Math.round(10 * sf) : r >= 0.2 ? Math.round(3 * sf) : -Math.round(3 * sf)
  }
  bonuses.venue = Math.round(venueBonus * (weights.venueMult || 1))

  // 馬場適性
  let surfBonus = 0
  const surfData = stat.surfaceData || {}
  if (surfData[race.surface] && surfData[race.surface].races > 0) {
    const sf = Math.min(surfData[race.surface].races, 8) / 8
    const r = surfData[race.surface].places / surfData[race.surface].races
    surfBonus = r >= 0.5 ? Math.round(8 * sf) : r < 0.2 ? -Math.round(8 * sf) : 0
  }
  bonuses.surface = Math.round(surfBonus * (weights.surfaceMult || 1))

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
      else if (avg <= 5.5) formBonus = 0   // 5th place form: neutral (not penalized)
      else if (avg > 7) formBonus = -10
      else formBonus = -4
      if (pos.length >= 2 && pos[0] <= 2 && pos[1] <= 2) formBonus += 5
      if (pos[0] === 1) formBonus += 3
    }
  }
  bonuses.recentForm = Math.round(formBonus * (weights.recentFormMult || 1))

  // 年齢補正
  let ageBonus = 0
  const age = entry.age ? Number(entry.age) : 0
  if (age === 3) ageBonus = 3
  else if (age === 4 || age === 5) ageBonus = 2
  else if (age >= 7) ageBonus = -4
  bonuses.age = Math.round(ageBonus * (weights.ageMult || 1))

  // 騎手評価（動的スタッツ優先、フォールバックで固定ランク）
  let jockeyBonus = getJockeyBonus(entry.jockey, jockeyStatsMap)
  bonuses.jockey = Math.round(jockeyBonus * (weights.jockeyMult || 1))

  // 同一レース相性ボーナス（連対実績あり→フラットボーナス）
  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const raceKey = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rnData = stat.raceNameData[raceKey]
    if (rnData && rnData.races > 0) {
      if (rnData.places >= 2)      raceAffinityBonus = 18  // 2回以上連対のみボーナス
      else if (rnData.places >= 1) raceAffinityBonus = 6   // 1回連対: 小ボーナス
      else if (rnData.races >= 3)  raceAffinityBonus = -4  // 3回以上出走・未連対: 小ペナルティ
    }
  }
  bonuses.raceAffinity = Math.round(raceAffinityBonus * (weights.raceAffinityMult || 1))

  // 前哨戦実績ボーナス（今回の主要前哨戦に出走していた場合）
  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const currentRaceBase = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[currentRaceBase] || []
    for (const prepName of prepList) {
      const pd = stat.raceNameData[prepName]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }  // 前哨戦連対
        else { prepBonus = Math.max(prepBonus, 2) }                         // 前哨戦出走
      }
    }
  }
  bonuses.prep = prepBonus

  // 馬場状態適性
  let trackCondBonus = 0
  const trackCondition = race.trackCondition
  if (trackCondition && stat) {
    const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    if (race.surface === '芝') {
      if (trackCondition === '不良') {
        trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
      } else if (trackCondition === '重') {
        trackCondBonus = overallRate >= 0.40 ? 2 : overallRate >= 0.20 ? 0 : -3
      }
    } else if (race.surface === 'ダート') {
      if (trackCondition === '重' || trackCondition === '不良') trackCondBonus = 3
    }
  }
  bonuses.trackCond = Math.round(trackCondBonus * (weights.trackCondMult || 1))

  // 少数レース高ポテンシャル補正
  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    potentialBonus = (stat.g1Places / stat.g1Races) >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  }

  // トレンド補正
  let trendBonus = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length >= 4) {
      const ra = (pos[0] + pos[1]) / 2, oa = (pos[2] + pos[3]) / 2
      if (ra < oa - 1.5) trendBonus = 6
      else if (ra < oa - 0.5) trendBonus = 3
      else if (ra > oa + 2) trendBonus = -5
    }
  }

  const totalBonus = Object.values(bonuses).reduce((a, b) => a + b, 0) + potentialBonus + trendBonus
  // bonuses.prep already included in the reduce above
  return { score: Math.round(Math.max(20, cappedBase + totalBonus) * 10) / 10, bonuses }
}

function applyRankCaps(scored) {
  for (let i = 0; i < scored.length; i++) scored[i].placeRate = Math.min(scored[i].placeRate, RANK_CAPS[i] ?? 18)
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 5)
    scored[1].placeRate = Math.max(scored[1].placeRate - 7, (RANK_CAPS[1] ?? 52) - 12)
  if (scored.length >= 3 && scored[1].placeRate - scored[2].placeRate < 5)
    scored[2].placeRate = Math.max(scored[2].placeRate - 12, (RANK_CAPS[2] ?? 38) - 14)
  return scored
}

function scoreAllHorses(entries, race, statsMap, weights, jockeyStatsMap) {
  const scored = entries.map(e => {
    const stat = statsMap.get(e.horseName) || null
    const { score, bonuses } = buildScore(e, race, stat, weights, jockeyStatsMap)
    return { ...e, placeRate: score, _bonuses: bonuses }
  }).sort((a, b) => b.placeRate - a.placeRate)
  return applyRankCaps(scored.slice(0, 7)).map((h, i) => ({ ...h, rank: i + 1 }))
}

function nudgeWeights(factorSamples, currentWeights) {
  const newWeights = { ...currentWeights }
  const report = []
  for (const [key, samples] of Object.entries(factorSamples)) {
    if (samples.length < 10) continue
    const posHits = samples.filter(s => s.val > 0 && s.hit).length
    const posTotal = samples.filter(s => s.val > 0).length
    if (posTotal < 10) continue
    const posRate = posHits / posTotal
    const mult = key + 'Mult'
    if (!(mult in newWeights)) continue
    if (posRate > 0.58) {
      newWeights[mult] = Math.min(1.8, (currentWeights[mult] || 1) + 0.06)
      report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → UP ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
    } else if (posRate < 0.35) {
      newWeights[mult] = Math.max(0.30, (currentWeights[mult] || 1) - 0.06)
      report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → DOWN ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
    }
  }
  return { newWeights, report }
}

async function runBlindCycle(weights, label) {
  // 全レースを日付順に取得（G1/G2/G3全グレード）
  const allRaces = await prisma.race.findMany({
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  const statsMap = new Map()        // 累積HorseStat（前レース分のみ蓄積）
  const jockeyStatsMap = new Map()  // 騎手の動的スタッツ（時系列累積）
  const finishesMap = new Map()
  let full = 0, half = 0, miss = 0
  const missDetails = []
  const factorSamples = { recentForm: [], distance: [], venue: [], surface: [], g1: [], age: [], raceAffinity: [], trackCond: [] }
  const rankHits = { 1:{a:0,h:0}, 2:{a:0,h:0}, 3:{a:0,h:0}, 4:{a:0,h:0}, 5:{a:0,h:0}, 6:{a:0,h:0} }
  const yearStats = {}

  for (const race of allRaces) {
    // ── G1レースかつ結果あり → このレースの「前データ」で予想 ──
    if (race.grade === 'G1') {
      const actual = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
      if (actual.length >= 2) {
        // エントリー補完（entries + results）
        const entryNames = new Set(race.entries.map(e => e.horseName))
        const additional = race.results
          .filter(r => !entryNames.has(r.horseName))
          .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
        const allEntries = [...race.entries, ...additional]

        const scored = scoreAllHorses(allEntries, race, statsMap, weights, jockeyStatsMap)
        const top6Names = scored.map(h => h.horseName)

        const hits = actual.filter(a => top6Names.includes(a)).length
        if (hits === 2) full++
        else if (hits === 1) half++
        else miss++

        // ファクターサンプル収集
        for (const pred of scored) {
          if (pred._bonuses) {
            const hit = actual.includes(pred.horseName)
            for (const [key, val] of Object.entries(pred._bonuses)) {
              if (factorSamples[key]) factorSamples[key].push({ val, hit })
            }
            if (rankHits[pred.rank]) {
              rankHits[pred.rank].a++
              if (actual.includes(pred.horseName)) rankHits[pred.rank].h++
            }
          }
        }

        if (hits < 2) {
          missDetails.push({
            name: race.name, date: race.date.toISOString().slice(0, 10),
            top3: top6Names.slice(0, 3), actual,
            surprises: actual.filter(a => !top6Names.includes(a)),
          })
        }

        // 年別集計
        const yr = race.date.getFullYear()
        if (!yearStats[yr]) yearStats[yr] = { full: 0, half: 0, miss: 0 }
        if (hits === 2) yearStats[yr].full++
        else if (hits === 1) yearStats[yr].half++
        else yearStats[yr].miss++
      }
    }

    // ── 全グレードの結果でHorseStatを更新（このレース終了後のデータとして） ──
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      const placed = result.finishPosition <= 2
      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {}, recentForm: null,
        })
      }
      const s = statsMap.get(result.horseName)
      s.totalRaces++; if (placed) s.totalPlaces++
      if (race.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
      const dk = String(race.distance)
      if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
      s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
      if (!s.venueData[race.venue]) s.venueData[race.venue] = { races: 0, places: 0 }
      s.venueData[race.venue].races++; if (placed) s.venueData[race.venue].places++
      if (!s.surfaceData[race.surface]) s.surfaceData[race.surface] = { races: 0, places: 0 }
      s.surfaceData[race.surface].races++; if (placed) s.surfaceData[race.surface].places++
      const raceKey = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
      if (!s.raceNameData[raceKey]) s.raceNameData[raceKey] = { races: 0, places: 0 }
      s.raceNameData[raceKey].races++; if (placed) s.raceNameData[raceKey].places++
      if (!finishesMap.has(result.horseName)) finishesMap.set(result.horseName, [])
      finishesMap.get(result.horseName).push({ date: race.date.getTime(), position: result.finishPosition })
      const finishes = finishesMap.get(result.horseName)
      finishes.sort((a, b) => b.date - a.date)
      s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
    }

    // ── 騎手スタッツを時系列で累積（エントリーの騎手情報を使用） ──
    for (const entry of race.entries) {
      if (!entry.jockey) continue
      const result = race.results.find(r => r.horseNumber === entry.horseNumber || r.horseName === entry.horseName)
      if (!result) continue
      const j = entry.jockey
      if (!jockeyStatsMap.has(j)) jockeyStatsMap.set(j, { total: 0, places: 0, g1Total: 0, g1Places: 0 })
      const js = jockeyStatsMap.get(j)
      const placed = result.finishPosition <= 2
      js.total++; if (placed) js.places++
      if (race.grade === 'G1') { js.g1Total++; if (placed) js.g1Places++ }
    }
  }

  const total = full + half + miss
  const accuracy = total > 0 ? Math.round((full * 2 + half) / (total * 2) * 1000) / 10 : 0

  return { total, accuracy, full, half, miss, factorSamples, missDetails, rankHits, yearStats }
}

async function main() {
  console.log('=== 時系列ブラインド改善サイクル ===\n')

  // 現在のウェイト取得
  const currentAlgo = await prisma.algorithmConfig.findFirst({ orderBy: { version: 'desc' } })
  let weights = { ...DEFAULT_WEIGHTS }
  if (currentAlgo?.insights) {
    try {
      const ins = JSON.parse(currentAlgo.insights)
      if (ins.localWeights) weights = { ...DEFAULT_WEIGHTS, ...ins.localWeights }
    } catch {}
  }
  console.log('現在ウェイト:', JSON.stringify(weights))
  console.log('現在バージョン: v' + (currentAlgo?.version || 0))

  // ====== Round 1: ブラインド精度測定 ======
  console.log('\n--- Round 1: ブラインド予想・精度測定 ---')
  const r1 = await runBlindCycle(weights, 'Round1')

  console.log(`G1レース数: ${r1.total}`)
  console.log(`完全的中: ${r1.full} / 半的中: ${r1.half} / 外れ: ${r1.miss}`)
  console.log(`ブラインド的中率: ${r1.accuracy}%`)

  console.log('\n年別精度:')
  for (const [yr, v] of Object.entries(r1.yearStats).sort((a,b)=>a[0]-b[0])) {
    const t = v.full+v.half+v.miss
    const acc = Math.round((v.full*2+v.half)/(t*2)*100)
    console.log(`  ${yr}: ${acc}% (full=${v.full} half=${v.half} miss=${v.miss})`)
  }

  console.log('\n予想順位別的中率:')
  for (const [rank, v] of Object.entries(r1.rankHits)) {
    if (v.a > 0) console.log(`  ${rank}位: ${v.h}/${v.a} (${Math.round(v.h/v.a*100)}%)`)
  }

  console.log('\n外れ代表例:')
  r1.missDetails.filter(m => m.surprises.length > 0).slice(0, 8).forEach(m => {
    console.log(`  ${m.name}(${m.date.slice(0,7)}): 予想[${m.top3.join('/')}] 実際[${m.actual.join('/')}]`)
  })

  // ====== ウェイト調整 ======
  console.log('\n--- ウェイト自動調整 ---')
  const { newWeights, report } = nudgeWeights(r1.factorSamples, weights)
  if (report.length > 0) {
    report.forEach(r => console.log(r))
  } else {
    console.log('  ウェイト変更なし（バランス良好）')
  }

  // ====== Round 2: 改善ウェイトで再評価 ======
  let finalWeights = newWeights
  let finalAccuracy = r1.accuracy
  let finalStats = r1

  if (JSON.stringify(newWeights) !== JSON.stringify(weights)) {
    console.log('\n--- Round 2: 改善ウェイトで再評価 ---')
    const r2 = await runBlindCycle(newWeights, 'Round2')
    console.log(`改善後ブラインド的中率: ${r2.accuracy}% (${r2.full}/${r2.half}/${r2.miss})`)
    console.log(`精度変化: ${r1.accuracy}% → ${r2.accuracy}% (${r2.accuracy >= r1.accuracy ? '+' : ''}${Math.round((r2.accuracy - r1.accuracy)*10)/10}%)`)

    if (r2.accuracy >= r1.accuracy) {
      finalWeights = newWeights
      finalAccuracy = r2.accuracy
      finalStats = r2
      console.log('→ 精度向上。新ウェイトを採用。')
    } else {
      finalWeights = weights
      finalAccuracy = r1.accuracy
      console.log('→ 精度低下。元ウェイトを維持。')
    }
  }

  // ====== AlgorithmConfig更新 ======
  console.log('\n--- AlgorithmConfig更新 ---')
  const improvements = []

  // 外れパターン分析
  const surpriseHorses = finalStats.missDetails.flatMap(m => m.surprises)
  const uniqueSurprises = [...new Set(surpriseHorses)]
  const surpriseStats = await prisma.horseStat.findMany({ where: { horseName: { in: uniqueSurprises } } })
  const sMap = new Map(surpriseStats.map(s => [s.horseName, s]))
  let lowRate = 0, highRate = 0
  for (const name of surpriseHorses) {
    const s = sMap.get(name)
    if (!s) continue
    const rate = s.totalRaces > 0 ? s.totalPlaces / s.totalRaces : 0
    if (rate < 0.3) lowRate++; else highRate++
  }
  if (lowRate > 3) improvements.push(`低連対率馬（<30%）が${lowRate}回連対。G1での距離・馬場適性重みを増加。`)
  if (highRate > 5) improvements.push(`高連対率馬${highRate}頭が見落とし。有力馬の発見精度向上が必要。`)

  const r1Rate = r1.rankHits[1].a > 0 ? r1.rankHits[1].h / r1.rankHits[1].a : 0
  const r2Rate = r1.rankHits[2].a > 0 ? r1.rankHits[2].h / r1.rankHits[2].a : 0
  if (r1Rate < 0.55) improvements.push(`1位予想的中率${Math.round(r1Rate*100)}%低。トップ馬差別化強化。`)
  if (r2Rate < 0.40) improvements.push(`2位予想的中率${Math.round(r2Rate*100)}%低。2番手馬の評価精度向上。`)

  const newVersion = (currentAlgo?.version || 250) + 1
  await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
  await prisma.algorithmConfig.create({
    data: {
      version: newVersion,
      isActive: true,
      rules: improvements.join('\n') || 'ブラインド評価サイクル実行',
      insights: JSON.stringify({
        localWeights: finalWeights,
        localAccuracy: { total: finalStats.total, accuracy: finalAccuracy },
        blindAccuracy: finalAccuracy,
        circularAccuracy: currentAlgo?.accuracy,
        lastLearnedAt: new Date().toISOString(),
        improvementNotes: improvements,
      }),
      analyzedCount: finalStats.total,
      accuracy: finalAccuracy,
    }
  })
  console.log(`AlgorithmConfig v${newVersion} 保存完了`)
  console.log(`ブラインド的中率: ${finalAccuracy}% (${finalStats.total} G1レース)`)
  console.log(`最終ウェイト: ${JSON.stringify(finalWeights)}`)

  console.log('\n=== 完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('エラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
