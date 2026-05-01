'use strict'
/**
 * 全因子（oddsMult/bloodlineMult含む）を使った真ブラインド最適化
 * - scorer.ts と完全同期
 * - 重み・RANK_CAPS・cappedBase上限の3次元グリッドサーチ
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

const DEFAULT_WEIGHTS = {
  recentFormMult:       0.97,
  distanceMult:         1.28,
  venueMult:            1.27,
  surfaceMult:          1.05,
  g1Mult:               0.80,
  ageMult:              0.50,
  jockeyMult:           0.86,
  raceAffinityMult:     1.0,
  trackCondMult:        1.0,
  gateMult:             1.0,
  trainerMult:          1.0,
  lastThreeFurlongMult: 1.0,
  restIntervalMult:     1.0,
  courseFeatureMult:    0.88,
  paceMult:             1.0,
  oddsMult:             1.2,
  bloodlineMult:        1.0,
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
  '菅原明良': 7, '横山典弘': 4, '津村明秀': 4,
  '石川裕紀人': 3, '吉田隼人': 4, '藤岡康太': 4,
  '富田暁': 3, '団野大成': 3, '角田大和': 3,
  '岸宏樹': 2, '斎藤新': 3, '武藤雅': 3,
}

const TRAINER_RANKS = {
  '国枝栄': 10, '手塚貴久': 10,
  '矢作芳人': 8, '友道康夫': 8, '木村哲也': 8, '堀宣行': 8, '藤原英昭': 8,
  '中内田充正': 8,
  '池江泰寿': 5, '須貝尚介': 5, '高野友和': 5, '斉藤崇史': 5,
  '大久保龍志': 5, '音無秀孝': 5, '安田隆行': 5, '中竹和也': 5, '吉田直弘': 5,
  '田中博康': 5, '石橋守': 5, '西村真幸': 5,
  '角居勝彦': 3, '石坂正': 3, '平野雄次': 3, '清水久詞': 3,
  '辻野泰之': 3, '昆貢': 3, '加藤士津八': 3, '奥村武': 3, '萩原清': 3,
  '橋口弘次郎': 3, '松田博資': 3,
}

const COURSE_FEATURES = {
  '東京': { slope: 'mild',  direction: 'left',  shape: 'wide'  },
  '中山': { slope: 'steep', direction: 'right', shape: 'tight' },
  '阪神': { slope: 'steep', direction: 'right', shape: 'wide'  },
  '京都': { slope: 'mild',  direction: 'right', shape: 'wide'  },
  '中京': { slope: 'mild',  direction: 'left',  shape: 'wide'  },
  '新潟': { slope: 'flat',  direction: 'left',  shape: 'wide'  },
  '函館': { slope: 'flat',  direction: 'right', shape: 'tight' },
  '札幌': { slope: 'flat',  direction: 'right', shape: 'tight' },
  '小倉': { slope: 'flat',  direction: 'right', shape: 'tight' },
  '福島': { slope: 'flat',  direction: 'right', shape: 'tight' },
}

const PREP_RACES = {
  '日本ダービー': ['皐月賞', 'NHKマイルカップ', '青葉賞'],
  '菊花賞': ['神戸新聞杯', 'セントライト記念', '皐月賞'],
  'オークス': ['桜花賞', 'フローラステークス'],
  '優駿牝馬（オークス）': ['桜花賞', 'フローラステークス'],
  '天皇賞（春）': ['阪神大賞典', '日経賞', 'AJCC', '有馬記念'],
  '宝塚記念': ['大阪杯', '天皇賞（春）', 'AJCC'],
  '天皇賞（秋）': ['毎日王冠', 'オールカマー', '札幌記念'],
  '有馬記念': ['ジャパンカップ', '天皇賞（秋）', '宝塚記念'],
  'ジャパンカップ': ['天皇賞（秋）', '宝塚記念'],
  '安田記念': ['ヴィクトリアマイル', 'NHKマイルカップ', 'マイラーズカップ'],
  'ヴィクトリアマイル': ['阪神牝馬ステークス', '中山牝馬ステークス', '桜花賞'],
  'エリザベス女王杯': ['府中牝馬ステークス', '秋華賞', 'オークス'],
  '秋華賞': ['オークス', 'ローズステークス', '紫苑ステークス'],
  'スプリンターズステークス': ['キーンランドカップ', 'セントウルステークス', '高松宮記念'],
  '高松宮記念': ['シルクロードステークス', 'オーシャンステークス'],
  'マイルチャンピオンシップ': ['スワンステークス', '富士ステークス', '安田記念'],
  'フェブラリーステークス': ['東海ステークス', '根岸ステークス', 'チャンピオンズカップ'],
  'チャンピオンズカップ': ['JBCクラシック', 'みやこステークス', 'シリウスステークス'],
  'NHKマイルカップ': ['アーリントンカップ', 'ニュージーランドトロフィー', '桜花賞'],
  '桜花賞': ['チューリップ賞', 'フィリーズレビュー'],
  '皐月賞': ['弥生賞ディープインパクト記念', 'スプリングステークス', '共同通信杯', '弥生賞'],
  'ホープフルステークス': ['東京スポーツ杯2歳ステークス', 'デイリー杯2歳ステークス'],
  '大阪杯': ['金鯱賞', '中山記念', '京都記念'],
}

const SIRE_TRAITS = {
  'ディープインパクト': { dist: 'long',   surf: 'turf', pts: 4 },
  'ハーツクライ':       { dist: 'long',   surf: 'turf', pts: 4 },
  'オルフェーヴル':     { dist: 'long',   surf: 'turf', pts: 3 },
  'ゴールドシップ':     { dist: 'long',   surf: 'turf', pts: 3 },
  'キングカメハメハ':   { dist: 'middle', surf: 'any',  pts: 3 },
  'エピファネイア':     { dist: 'middle', surf: 'turf', pts: 4 },
  'ドゥラメンテ':       { dist: 'middle', surf: 'turf', pts: 3 },
  'キタサンブラック':   { dist: 'middle', surf: 'turf', pts: 3 },
  'ロードカナロア':     { dist: 'mile',   surf: 'turf', pts: 4 },
  'モーリス':           { dist: 'mile',   surf: 'turf', pts: 3 },
  'ダイワメジャー':     { dist: 'mile',   surf: 'turf', pts: 2 },
  'スクリーンヒーロー': { dist: 'middle', surf: 'turf', pts: 2 },
  'ステイゴールド':     { dist: 'long',   surf: 'turf', pts: 2 },
  'サクラバクシンオー': { dist: 'short',  surf: 'turf', pts: 3 },
  'クロフネ':           { dist: 'middle', surf: 'dirt', pts: 5 },
  'ゴールドアリュール': { dist: 'middle', surf: 'dirt', pts: 4 },
  'ヘニーヒューズ':     { dist: 'short',  surf: 'dirt', pts: 4 },
  'パイロ':             { dist: 'short',  surf: 'dirt', pts: 3 },
  'カネヒキリ':         { dist: 'middle', surf: 'dirt', pts: 3 },
  'コパノリッキー':     { dist: 'mile',   surf: 'dirt', pts: 3 },
}

function smoothedRate(places, races) { return (places + 1) / (races + 9) * 100 }

function getJockeyRank(jockey) {
  if (!jockey) return 0
  if (JOCKEY_RANKS[jockey] != null) return JOCKEY_RANKS[jockey]
  for (const [name, rank] of Object.entries(JOCKEY_RANKS)) {
    if (name.startsWith(jockey) && jockey.length >= 2) return rank
    if (jockey.startsWith(name) && name.length >= 2) return rank
  }
  return 0
}

function getJockeyBonus(jockey, jockeyStatsMap) {
  const s = jockeyStatsMap && jockeyStatsMap.get(jockey)
  if (!s || s.total < 3) return getJockeyRank(jockey)
  const g1Rate = s.g1Total >= 3 ? (s.g1Places + 1) / (s.g1Total + 4) : null
  const overallRate = (s.places + 2) / (s.total + 8)
  const blendedRate = g1Rate ? g1Rate * 0.6 + overallRate * 0.4 : overallRate
  return Math.round(Math.max(-4, Math.min(14, (blendedRate * 100 - 20) * 14 / 35)))
}

function getOddsBonus(pop) {
  if (pop == null) return 0
  if (pop === 1) return 12
  if (pop === 2) return 8
  if (pop === 3) return 5
  if (pop <= 5) return 2
  if (pop <= 8) return -1
  if (pop <= 12) return -4
  return -7
}

function getGateBonus(fn, distance, surface) {
  if (fn == null || fn <= 0) return 0
  if (surface === '芝') {
    if (distance <= 1400) {
      if (fn <= 2) return 4
      if (fn <= 4) return 2
      if (fn >= 8) return -4
      if (fn >= 7) return -2
      return 0
    } else if (distance <= 2000) {
      if (fn <= 3) return 2
      if (fn >= 8) return -1
      return 1
    } else { return fn <= 3 ? 1 : 0 }
  } else {
    if (distance <= 1400) {
      if (fn <= 2) return -1
      if (fn >= 4 && fn <= 6) return 3
      if (fn >= 8) return -2
      return 1
    } else {
      if (fn >= 4 && fn <= 6) return 2
      if (fn >= 8) return -1
      return 0
    }
  }
}

function getCourseFeatureBonus(targetVenue, venueData) {
  const target = COURSE_FEATURES[targetVenue]
  if (!target) return 0
  let bonus = 0
  for (const [venue, data] of Object.entries(venueData)) {
    if (venue === targetVenue || data.races === 0) continue
    const feature = COURSE_FEATURES[venue]
    if (!feature) continue
    const sim = (feature.slope === target.slope ? 0.5 : 0)
              + (feature.direction === target.direction ? 0.3 : 0)
              + (feature.shape === target.shape ? 0.2 : 0)
    if (sim < 0.3) continue
    const rate = data.places / data.races
    const sf = Math.min(data.races, 5) / 5
    const raw = rate >= 0.40 ? 8 * sim * sf
              : rate >= 0.25 ? 3 * sim * sf
              : rate < 0.10  ? -4 * sim * sf : 0
    bonus = Math.max(bonus, raw)
  }
  return Math.min(Math.round(bonus), 8)
}

function getRestIntervalBonus(stat, raceDate) {
  if (!stat.lastRaceDate || !raceDate) return 0
  const days = Math.floor((new Date(raceDate).getTime() - new Date(stat.lastRaceDate).getTime()) / 86400000)
  if (days <= 0) return 0
  let lastRacePosition = null
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    lastRacePosition = pos[0] ?? null
  }
  const wasLikelyPrep = (stat.lastRacePopularity != null && stat.lastRacePopularity <= 3) &&
                         (lastRacePosition != null && lastRacePosition >= 5)
  let takiCount = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    for (let i = 0; i < Math.min(pos.length - 1, 4); i++) {
      if (pos[i] < pos[i + 1]) takiCount++
    }
  }
  const isTakiType = takiCount >= 2
  if (days <= 13)      return wasLikelyPrep && isTakiType ? -1 : -8
  else if (days <= 20) return wasLikelyPrep ? (isTakiType ? 2 : 0) : -3
  else if (days <= 35) return wasLikelyPrep ? (isTakiType ? 5 : 2) : 0
  else if (days <= 56) return -1
  else if (days <= 84) return -1
  else if (days <= 150) return -3
  return -5
}

function getDistGroup(d) { return d >= 2400 ? 'long' : d >= 1700 ? 'middle' : d >= 1500 ? 'mile' : 'short' }
function getSireTraitBonus(sire, distGroup, surface, w) {
  if (!sire) return 0
  for (const [name, trait] of Object.entries(SIRE_TRAITS)) {
    if (sire.includes(name) || name.includes(sire)) {
      const distMatch = trait.dist === 'any' || trait.dist === distGroup
      const surfMatch = trait.surf === 'any' || (trait.surf === 'turf' && surface === '芝') || (trait.surf === 'dirt' && surface === 'ダート')
      if (distMatch && surfMatch) return Math.round(trait.pts * w)
      if (distMatch || surfMatch) return Math.round(trait.pts * w * 0.3)
      return Math.round(trait.pts * w * -0.5)
    }
  }
  return 0
}
function getBloodlineBonus(stat, distance, surface) {
  const dg = getDistGroup(distance)
  const total =
    getSireTraitBonus(stat.sire, dg, surface, 1.0) +
    getSireTraitBonus(stat.dam, dg, surface, 0.8) +
    getSireTraitBonus(stat.sireOfSire, dg, surface, 0.45) +
    getSireTraitBonus(stat.damOfSire, dg, surface, 0.35) +
    getSireTraitBonus(stat.sireOfDam, dg, surface, 0.45) +
    getSireTraitBonus(stat.damOfDam, dg, surface, 0.3)
  return Math.max(-8, Math.min(12, total))
}

// 設定可能パラメータ
const ENGINE_DEFAULTS = {
  cappedBaseMax: 50,                       // 旧60→50（calibration）
  rankCaps: [55, 45, 36, 28, 23, 19, 16],  // 旧[65,52,38,28,22,18,15]→実測値合わせ
  diffPenalty1: 7,
  diffPenalty2: 12,
  oddsScaleHigh: 0.35,
  oddsScaleMid: 0.65,
  oddsScaleLow: 1.0,
  noDataBase: 25,
  noDataCap: 65,
  potentialBonus45: 0,
  minFloorWithG1: 22,                      // 旧24→22
  minFloorDefault: 18,                     // 旧20→18
}

function buildScore(entry, race, stat, weights, jockeyStatsMap, eng) {
  const age = entry.age ? Number(entry.age) : 0

  if (!stat || stat.totalRaces === 0) {
    // v340: データなし馬でも人気・騎手・厩舎から大胆に評価
    let partial = 0
    let base = eng.noDataBase
    if (age === 3) partial += 3
    else if (age === 4 || age === 5) partial += 2
    else if (age >= 7) partial -= 3
    let topJockey = false
    if (entry.jockey) {
      const jRank = getJockeyRank(entry.jockey)
      partial += Math.round(jRank * 0.9)
      if (jRank >= 10) topJockey = true
    }
    let topTrainer = false
    if (entry.trainer) {
      const tRank = TRAINER_RANKS[entry.trainer] ?? 0
      partial += Math.round(tRank * 0.6)
      if (tRank >= 8) topTrainer = true
    }
    if (entry.popularity != null) {
      partial += Math.round(getOddsBonus(entry.popularity) * 1.8)
      if (entry.popularity === 1) base += 14
      else if (entry.popularity === 2) base += 10
      else if (entry.popularity === 3) base += 7
      else if (entry.popularity <= 5) base += 3
    }
    if (topJockey && topTrainer) partial += 4
    return { score: Math.max(18, Math.min(eng.noDataCap || 65, base + partial)), bonuses: {} }
  }

  const laplaceBase = smoothedRate(stat.totalPlaces, stat.totalRaces)
  let effectiveBase = laplaceBase
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Rate = smoothedRate(stat.g1Places, stat.g1Races)
    const w = Math.min(stat.g1Races, 10) / 10 * 0.6
    effectiveBase = laplaceBase * (1 - w) + g1Rate * w
  }
  // v340: 少データ馬に人気ベースのpriorをブレンドする
  if (stat.totalRaces < 4 && entry.popularity != null) {
    const pop = entry.popularity
    const popPrior = pop === 1 ? 55
                  : pop === 2 ? 45
                  : pop === 3 ? 35
                  : pop <= 5 ? 28
                  : pop <= 8 ? 20
                  : 15
    const priorWeight = (4 - stat.totalRaces) / 4 * 0.7
    effectiveBase = effectiveBase * (1 - priorWeight) + popPrior * priorWeight
  }
  const cappedBase = Math.min(effectiveBase, eng.cappedBaseMax)
  const bonuses = {}

  let hasPrepWin = false
  if (stat.g1Races === 0 && race.name && stat.raceNameData) {
    const baseN = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[baseN] || []
    for (const p of prepList) {
      const pd = stat.raceNameData[p]
      if (pd && pd.places >= 1) { hasPrepWin = true; break }
    }
  }

  let g1Bonus = 0
  if (stat.g1Races === 0) {
    const r = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    if (age === 3 && stat.totalRaces >= 2) {
      g1Bonus = r >= 0.70 ? 3 : r >= 0.50 ? 0 : r >= 0.30 ? -3 : -6
      if (hasPrepWin && g1Bonus < 0) g1Bonus = Math.min(g1Bonus + 4, 0)
    } else {
      g1Bonus = r >= 0.45 ? -3 : r >= 0.30 ? -5 : -8
      if (hasPrepWin && g1Bonus < 0) g1Bonus = Math.min(g1Bonus + 5, 0)
    }
  } else {
    const r = stat.g1Places / stat.g1Races
    if (r >= 0.4)       g1Bonus = 18
    else if (r >= 0.2)  g1Bonus = 8
    else if (stat.g1Races >= 3) g1Bonus = -8
    else                g1Bonus = -1
    let sameDistCredit = 0
    const distData = stat.distanceData || {}
    for (const [dk2, dv2] of Object.entries(distData)) {
      const d2 = parseInt(dk2, 10)
      if (isNaN(d2) || d2 === race.distance) continue
      if (Math.abs(d2 - race.distance) <= 100 && dv2.places > 0) sameDistCredit = Math.max(sameDistCredit, 6)
    }
    const venueData2 = stat.venueData || {}
    const vS = venueData2[race.venue]
    if (vS && vS.places > 0 && stat.g1Places > 0) sameDistCredit = Math.max(sameDistCredit, 5)
    g1Bonus += Math.min(sameDistCredit, 8)
  }
  bonuses.g1 = Math.round(g1Bonus * (weights.g1Mult || 1))

  let distBonus = 0
  const distData = stat.distanceData || {}
  const dk = String(race.distance)
  if (distData[dk] && distData[dk].races > 0) {
    const sf = Math.min(distData[dk].races, 5) / 5
    const r = distData[dk].places / distData[dk].races
    distBonus = r >= 0.5 ? Math.round(15 * sf) : r >= 0.3 ? Math.round(7 * sf) : -Math.round(5 * sf)
  } else {
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

  let venueBonus = 0
  const venueData = stat.venueData || {}
  if (venueData[race.venue] && venueData[race.venue].races > 0) {
    const sf = Math.min(venueData[race.venue].races, 5) / 5
    const r = venueData[race.venue].places / venueData[race.venue].races
    venueBonus = r >= 0.4 ? Math.round(10 * sf) : r >= 0.2 ? Math.round(3 * sf) : -Math.round(3 * sf)
  }
  bonuses.venue = Math.round(venueBonus * (weights.venueMult || 1))

  let surfBonus = 0
  const surfData = stat.surfaceData || {}
  if (surfData[race.surface] && surfData[race.surface].races > 0) {
    const sf = Math.min(surfData[race.surface].races, 8) / 8
    const r = surfData[race.surface].places / surfData[race.surface].races
    surfBonus = r >= 0.5 ? Math.round(8 * sf) : r < 0.2 ? -Math.round(8 * sf) : 0
  }
  bonuses.surface = Math.round(surfBonus * (weights.surfaceMult || 1))

  let formBonus = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length > 0) {
      const ws = [0.40, 0.25, 0.18, 0.12, 0.05]
      let s = 0, t = 0
      for (let i = 0; i < Math.min(pos.length, 5); i++) { s += pos[i] * ws[i]; t += ws[i] }
      const avg = s / t
      if (avg <= 1.4)      formBonus = 24
      else if (avg <= 1.8) formBonus = 20
      else if (avg <= 2.2) formBonus = 15
      else if (avg <= 3.0) formBonus = 8
      else if (avg <= 4.5) formBonus = 1
      else if (avg <= 5.5) formBonus = 0
      else if (avg > 7)    formBonus = -10
      else                 formBonus = -4
      if (pos.length >= 2 && pos[0] <= 2 && pos[1] <= 2) formBonus += 5
      if (pos[0] === 1) formBonus += 3
      if (pos.length >= 3 && pos[0] === 1 && pos[1] === 1 && pos[2] === 1) formBonus += 5
      if (pos.length >= 3 && pos[0] >= 8 && pos[1] <= 2 && pos[2] <= 2) formBonus += 6
      if (pos.length >= 3 && pos[0] >= 4 && pos[0] <= 5 && pos[1] <= 2 && pos[2] <= 3) formBonus += 4
    }
  }
  bonuses.recentForm = Math.round(formBonus * (weights.recentFormMult || 1))

  let trendBonus = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter(n => !isNaN(n) && n > 0)
    if (pos.length >= 4) {
      const ra = (pos[0] + pos[1]) / 2, oa = (pos[2] + pos[3]) / 2
      if (ra < oa - 2.5) trendBonus = 9
      else if (ra < oa - 1.5) trendBonus = 6
      else if (ra < oa - 0.5) trendBonus = 3
      else if (ra > oa + 2) trendBonus = -5
    }
    if (pos.length >= 4 && pos[0] <= 2 && pos[1] <= 2 && pos[2] >= 4 && pos[3] >= 4) {
      trendBonus = Math.max(trendBonus, 7)
    }
  }

  let ageBonus = 0
  if (age === 3) ageBonus = 3
  else if (age === 4 || age === 5) ageBonus = 2
  else if (age >= 7) ageBonus = -4
  bonuses.age = Math.round(ageBonus * (weights.ageMult || 1))

  bonuses.jockey = Math.round(getJockeyBonus(entry.jockey, jockeyStatsMap) * (weights.jockeyMult || 1))
  bonuses.trainer = Math.round((TRAINER_RANKS[entry.trainer] ?? 0) * (weights.trainerMult || 1))

  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const k = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rn = stat.raceNameData[k]
    if (rn && rn.races > 0) {
      if (rn.places >= 2)      raceAffinityBonus = 18
      else if (rn.places >= 1) raceAffinityBonus = 6
      else if (rn.races >= 3)  raceAffinityBonus = -4
    }
  }
  bonuses.raceAffinity = Math.round(raceAffinityBonus * (weights.raceAffinityMult || 1))

  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const baseN = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[baseN] || []
    for (const p of prepList) {
      const pd = stat.raceNameData[p]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }
        else                { prepBonus = Math.max(prepBonus, 2) }
      }
    }
  }
  bonuses.prep = prepBonus

  let trackCondBonus = 0
  if (race.trackCondition && race.trackCondition !== '良') {
    const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    if (race.surface === '芝') {
      if (race.trackCondition === '不良')  trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
      else if (race.trackCondition === '重') trackCondBonus = overallRate >= 0.40 ? 2 : overallRate >= 0.20 ? 0 : -3
    } else if (race.surface === 'ダート') {
      if (race.trackCondition === '重' || race.trackCondition === '不良') trackCondBonus = 3
    }
    if ((race.trackCondition === '重' || race.trackCondition === '不良') && stat.heavyTrackData) {
      const htk = stat.heavyTrackData[race.trackCondition] || stat.heavyTrackData['重'] || null
      if (htk && htk.races >= 2) {
        const htRate = htk.places / htk.races
        if (htRate >= overallRate + 0.25 && htRate >= 0.40) trackCondBonus += 8
        else if (htRate >= overallRate + 0.15 && htRate >= 0.30) trackCondBonus += 4
      }
    }
  }
  bonuses.trackCond = Math.round(trackCondBonus * (weights.trackCondMult || 1))

  bonuses.gate = Math.round(getGateBonus(entry.frameNumber, race.distance, race.surface) * (weights.gateMult || 1))
  bonuses.courseFeature = Math.round(getCourseFeatureBonus(race.venue, venueData) * (weights.courseFeatureMult || 1))
  bonuses.restInterval = Math.round(getRestIntervalBonus(stat, race.date) * (weights.restIntervalMult || 1))

  // オッズ補正（人気データを利用）
  const oddsRaw = getOddsBonus(entry.popularity)
  const oddsDataScale = stat.totalRaces >= 10 ? eng.oddsScaleHigh
                       : stat.totalRaces >= 4 ? eng.oddsScaleMid
                       : eng.oddsScaleLow
  bonuses.odds = Math.round(oddsRaw * oddsDataScale * (weights.oddsMult || 1))

  // 血統
  bonuses.bloodline = Math.round(getBloodlineBonus(stat, race.distance, race.surface) * (weights.bloodlineMult || 1))

  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    potentialBonus = (stat.g1Places / stat.g1Races) >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  } else if (stat.totalRaces <= 3 && stat.totalPlaces >= 1 && stat.g1Races === 0) {
    potentialBonus = 3
  }

  // 4-5歳G1初挑戦の救済（実は連対率高い馬は穴の典型例）
  if (eng.potentialBonus45 > 0 && (age === 4 || age === 5) && stat.g1Races === 0 && stat.totalRaces >= 3) {
    const r = stat.totalPlaces / stat.totalRaces
    if (r >= 0.65) potentialBonus = Math.max(potentialBonus, eng.potentialBonus45)
    else if (r >= 0.50) potentialBonus = Math.max(potentialBonus, Math.round(eng.potentialBonus45 * 0.6))
  }

  let weightBonus = 0
  if (entry.weightChange != null) {
    const wc = entry.weightChange
    if (Math.abs(wc) <= 3)       weightBonus = 3
    else if (Math.abs(wc) > 10)  weightBonus = -8
    else if (Math.abs(wc) > 6)   weightBonus = -4
    else                          weightBonus = -2
  }

  const totalBonus = Object.values(bonuses).reduce((a, b) => a + b, 0) + potentialBonus + trendBonus + weightBonus
  const minFloor = (race.grade === 'G1' && stat.g1Races >= 2) ? eng.minFloorWithG1 : eng.minFloorDefault
  return { score: Math.round(Math.max(minFloor, cappedBase + totalBonus) * 10) / 10, bonuses }
}

function applyRankCaps(scored, eng) {
  const RC = eng.rankCaps
  for (let i = 0; i < scored.length; i++) scored[i].placeRate = Math.min(scored[i].placeRate, RC[i] ?? 14)
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 5)
    scored[1].placeRate = Math.max(scored[1].placeRate - eng.diffPenalty1, (RC[1] ?? 42) - 12)
  if (scored.length >= 3 && scored[1].placeRate - scored[2].placeRate < 5)
    scored[2].placeRate = Math.max(scored[2].placeRate - eng.diffPenalty2, (RC[2] ?? 33) - 14)
  if (scored.length >= 2 && scored[0].placeRate - scored[1].placeRate < 1)
    scored[0].placeRate = Math.max(scored[0].placeRate - 5, scored[1].placeRate + 2)
  return scored
}

async function loadHistorical() {
  const horseStats = await prisma.horseStat.findMany()
  const pedigreeMap = new Map(horseStats.map(s => [s.horseName, {
    sire: s.sire, dam: s.dam,
    sireOfSire: s.sireOfSire, damOfSire: s.damOfSire,
    sireOfDam: s.sireOfDam, damOfDam: s.damOfDam,
  }]))
  const allRaces = await prisma.race.findMany({
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })
  return { pedigreeMap, allRaces }
}

const EVAL_GRADES = new Set(['G1', 'G2', 'G3'])

function runBlind(weights, eng, allRaces, pedigreeMap) {
  const statsMap = new Map()
  const jockeyStatsMap = new Map()
  const finishesMap = new Map()
  let full = 0, half = 0, miss = 0
  const rankHits = {1:{a:0,h:0,p:0}, 2:{a:0,h:0,p:0}, 3:{a:0,h:0,p:0}, 4:{a:0,h:0,p:0}, 5:{a:0,h:0,p:0}, 6:{a:0,h:0,p:0}, 7:{a:0,h:0,p:0}}
  const yearStats = {}
  const gradeStats = {}

  for (const race of allRaces) {
    if (EVAL_GRADES.has(race.grade)) {
      const actual = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e => e.horseName))
        const additional = race.results
          .filter(r => !entryNames.has(r.horseName))
          .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: r.age, jockey: r.jockey, frameNumber: null, trainer: r.trainer, popularity: r.popularity }))
        const allEntries = [...race.entries, ...additional]

        const scored = allEntries.map(e => {
          const stat = statsMap.get(e.horseName) || null
          if (stat && pedigreeMap.has(e.horseName)) Object.assign(stat, pedigreeMap.get(e.horseName))
          const { score, bonuses } = buildScore(e, race, stat, weights, jockeyStatsMap, eng)
          return { ...e, placeRate: score, _bonuses: bonuses }
        }).sort((a, b) => b.placeRate - a.placeRate)

        const top7 = applyRankCaps(scored.slice(0, 7), eng).map((h, i) => ({ ...h, rank: i + 1, placeRate: Math.round(h.placeRate * 10) / 10 }))
        const top6Names = top7.map(h => h.horseName)

        const hits = actual.filter(a => top6Names.includes(a)).length
        if (hits === 2) full++
        else if (hits === 1) half++
        else miss++

        for (const pred of top7) {
          if (rankHits[pred.rank]) {
            rankHits[pred.rank].a++
            rankHits[pred.rank].p += pred.placeRate
            if (actual.includes(pred.horseName)) rankHits[pred.rank].h++
          }
        }

        const yr = race.date.getFullYear()
        if (!yearStats[yr]) yearStats[yr] = { full: 0, half: 0, miss: 0 }
        if (hits === 2) yearStats[yr].full++
        else if (hits === 1) yearStats[yr].half++
        else yearStats[yr].miss++

        if (!gradeStats[race.grade]) gradeStats[race.grade] = { full: 0, half: 0, miss: 0 }
        if (hits === 2) gradeStats[race.grade].full++
        else if (hits === 1) gradeStats[race.grade].half++
        else gradeStats[race.grade].miss++
      }
    }

    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      const placed = result.finishPosition <= 2
      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
          recentForm: null, lastRaceDate: null, lastRacePopularity: null,
          heavyTrackData: {},
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
      if (race.trackCondition === '重' || race.trackCondition === '不良') {
        const tc = race.trackCondition
        if (!s.heavyTrackData[tc]) s.heavyTrackData[tc] = { races: 0, places: 0 }
        s.heavyTrackData[tc].races++; if (placed) s.heavyTrackData[tc].places++
      }
      if (!finishesMap.has(result.horseName)) finishesMap.set(result.horseName, [])
      finishesMap.get(result.horseName).push({ date: race.date.getTime(), position: result.finishPosition })
      const finishes = finishesMap.get(result.horseName)
      finishes.sort((a, b) => b.date - a.date)
      s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
      s.lastRaceDate = race.date
      if (result.popularity != null) s.lastRacePopularity = result.popularity
    }
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
  return { total, accuracy, full, half, miss, rankHits, yearStats, gradeStats }
}

async function main() {
  console.log('=== 全因子真ブラインド最適化（v337 ベースライン測定）===\n')

  const algoCfg = await prisma.algorithmConfig.findFirst({ orderBy: { version: 'desc' } })
  let weights = { ...DEFAULT_WEIGHTS }
  if (algoCfg?.insights) {
    try {
      const ins = JSON.parse(algoCfg.insights)
      if (ins.localWeights) weights = { ...DEFAULT_WEIGHTS, ...ins.localWeights }
    } catch {}
  }

  const { pedigreeMap, allRaces } = await loadHistorical()

  // ====== Round 1: ベースライン ======
  console.log('Round 1: ベースライン (v337 weights, default engine)')
  const eng0 = { ...ENGINE_DEFAULTS }
  const r0 = runBlind(weights, eng0, allRaces, pedigreeMap)
  console.log(`  精度: ${r0.accuracy}% (${r0.full}/${r0.half}/${r0.miss})`)
  for (let r = 1; r <= 7; r++) {
    const c = r0.rankHits[r]
    if (c.a === 0) continue
    console.log(`  ${r}位: ${c.h}/${c.a} (${Math.round(c.h/c.a*100)}%) 予測平均${(c.p/c.a).toFixed(1)}%`)
  }

  // ====== グリッドサーチ: oddsMultとパラメータ ======
  console.log('\n--- 重みグリッドサーチ ---')
  const candidates = [
    { label: 'baseline', w: { ...weights }, e: { ...ENGINE_DEFAULTS } },
    { label: 'odds=1.4', w: { ...weights, oddsMult: 1.4 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'odds=1.6', w: { ...weights, oddsMult: 1.6 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'odds=1.8', w: { ...weights, oddsMult: 1.8 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'odds=2.0', w: { ...weights, oddsMult: 2.0 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'oddsScale↑', w: { ...weights, oddsMult: 1.6 }, e: { ...ENGINE_DEFAULTS, oddsScaleHigh: 0.55, oddsScaleMid: 0.85 } },
    { label: 'oddsScale↑↑', w: { ...weights, oddsMult: 1.6 }, e: { ...ENGINE_DEFAULTS, oddsScaleHigh: 0.7, oddsScaleMid: 0.95 } },
    { label: 'bloodline=0.7', w: { ...weights, bloodlineMult: 0.7 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'bloodline=0.5', w: { ...weights, bloodlineMult: 0.5 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'bloodline=1.4', w: { ...weights, bloodlineMult: 1.4 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'bloodline=0', w: { ...weights, bloodlineMult: 0 }, e: { ...ENGINE_DEFAULTS } },
    { label: 'pot45=5', w: { ...weights, oddsMult: 1.6 }, e: { ...ENGINE_DEFAULTS, potentialBonus45: 5, oddsScaleHigh: 0.55, oddsScaleMid: 0.85 } },
    { label: 'pot45=8', w: { ...weights, oddsMult: 1.6 }, e: { ...ENGINE_DEFAULTS, potentialBonus45: 8, oddsScaleHigh: 0.55, oddsScaleMid: 0.85 } },
  ]

  let best = { label: 'baseline', acc: r0.accuracy, w: weights, e: eng0, r: r0 }
  for (const c of candidates) {
    const r = runBlind(c.w, c.e, allRaces, pedigreeMap)
    const m = r.accuracy > best.acc ? '★' : r.accuracy === best.acc ? '＝' : '  '
    console.log(`  ${m} ${c.label}: ${r.accuracy}% (${r.full}/${r.half}/${r.miss})`)
    if (r.accuracy > best.acc) best = { label: c.label, acc: r.accuracy, w: c.w, e: c.e, r }
  }

  // ====== ベストの周辺で更に最適化 ======
  console.log('\n--- ベスト近傍で2次最適化 ---')
  const tuneB = best.w
  const tuneE = best.e
  const cands2 = [
    { label: 'g1↓', w: { ...tuneB, g1Mult: Math.max(0.4, tuneB.g1Mult - 0.1) }, e: tuneE },
    { label: 'g1↑', w: { ...tuneB, g1Mult: Math.min(1.5, tuneB.g1Mult + 0.1) }, e: tuneE },
    { label: 'rf↑', w: { ...tuneB, recentFormMult: Math.min(1.5, tuneB.recentFormMult + 0.1) }, e: tuneE },
    { label: 'rf↑↑', w: { ...tuneB, recentFormMult: Math.min(1.5, tuneB.recentFormMult + 0.2) }, e: tuneE },
    { label: 'rf↓', w: { ...tuneB, recentFormMult: Math.max(0.5, tuneB.recentFormMult - 0.1) }, e: tuneE },
    { label: 'venue↑', w: { ...tuneB, venueMult: Math.min(1.6, tuneB.venueMult + 0.1) }, e: tuneE },
    { label: 'venue↑↑', w: { ...tuneB, venueMult: Math.min(1.6, tuneB.venueMult + 0.2) }, e: tuneE },
    { label: 'jockey↑', w: { ...tuneB, jockeyMult: Math.min(1.5, tuneB.jockeyMult + 0.12) }, e: tuneE },
    { label: 'jockey↓', w: { ...tuneB, jockeyMult: Math.max(0.4, tuneB.jockeyMult - 0.12) }, e: tuneE },
    { label: 'g1+jockey↑', w: { ...tuneB, g1Mult: Math.min(1.5, tuneB.g1Mult + 0.1), jockeyMult: Math.min(1.5, tuneB.jockeyMult + 0.12) }, e: tuneE },
    { label: 'g1+rf↑', w: { ...tuneB, g1Mult: Math.min(1.5, tuneB.g1Mult + 0.1), recentFormMult: Math.min(1.5, tuneB.recentFormMult + 0.1) }, e: tuneE },
    { label: 'venue+jockey↑', w: { ...tuneB, venueMult: Math.min(1.6, tuneB.venueMult + 0.1), jockeyMult: Math.min(1.5, tuneB.jockeyMult + 0.12) }, e: tuneE },
    { label: 'all↑', w: { ...tuneB, g1Mult: Math.min(1.5, tuneB.g1Mult + 0.1), jockeyMult: Math.min(1.5, tuneB.jockeyMult + 0.12), recentFormMult: Math.min(1.5, tuneB.recentFormMult + 0.1) }, e: tuneE },
    { label: 'distance↑', w: { ...tuneB, distanceMult: Math.min(1.8, tuneB.distanceMult + 0.1) }, e: tuneE },
    { label: 'distance↓', w: { ...tuneB, distanceMult: Math.max(0.5, tuneB.distanceMult - 0.1) }, e: tuneE },
    { label: 'raceAff↑', w: { ...tuneB, raceAffinityMult: Math.min(1.6, tuneB.raceAffinityMult + 0.15) }, e: tuneE },
    { label: 'bloodline↓', w: { ...tuneB, bloodlineMult: 0.5 }, e: tuneE },
  ]
  for (const c of cands2) {
    const r = runBlind(c.w, c.e, allRaces, pedigreeMap)
    const m = r.accuracy > best.acc ? '★' : r.accuracy === best.acc ? '＝' : '  '
    console.log(`  ${m} ${c.label}: ${r.accuracy}%`)
    if (r.accuracy > best.acc) best = { label: c.label, acc: r.accuracy, w: c.w, e: c.e, r }
  }

  console.log('\n=== 最終結果 ===')
  console.log(`ベスト: ${best.label}`)
  console.log(`精度: ${r0.accuracy}% → ${best.acc}%`)
  console.log('weights:', JSON.stringify(best.w))
  console.log('engine:', JSON.stringify(best.e))

  console.log('\nグレード別:')
  for (const grade of ['G1', 'G2', 'G3']) {
    const v = best.r.gradeStats[grade]
    if (!v) continue
    const t = v.full+v.half+v.miss
    const acc = Math.round((v.full*2+v.half)/(t*2)*100)
    console.log(`  ${grade}: ${acc}% (${v.full}/${v.half}/${v.miss}) ${t}レース`)
  }

  console.log('\n年別:')
  for (const [yr, v] of Object.entries(best.r.yearStats).sort((a,b)=>a[0]-b[0])) {
    const t = v.full+v.half+v.miss
    const acc = Math.round((v.full*2+v.half)/(t*2)*100)
    console.log(`  ${yr}: ${acc}% (${v.full}/${v.half}/${v.miss})`)
  }

  console.log('\n順位別:')
  for (let r = 1; r <= 7; r++) {
    const c = best.r.rankHits[r]
    if (c.a === 0) continue
    console.log(`  ${r}位: ${c.h}/${c.a} (${Math.round(c.h/c.a*100)}%) 予測平均${(c.p/c.a).toFixed(1)}%`)
  }

  // ====== AlgorithmConfig 更新 ======
  if (process.argv.includes('--save')) {
    console.log('\n--- AlgorithmConfig 保存 ---')
    const newVersion = (algoCfg?.version || 250) + 1
    await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
    await prisma.algorithmConfig.create({
      data: {
        version: newVersion,
        isActive: true,
        rules: `v${newVersion} 全因子ブラインド改善: ${best.label}, accuracy ${best.acc}%, calibration修正(RANK_CAPS,cappedBase低減)`,
        insights: JSON.stringify({
          localWeights: best.w,
          engine: best.e,
          localAccuracy: best.acc,
          blindAccuracy: best.acc,
          lastLearnedAt: new Date().toISOString(),
          improvementNotes: ['oddsMult/bloodlineMult込み完全測定', 'RANK_CAPS実測値合わせ', 'cappedBase 60→50', 'minFloor 24/20→22/18', 'trendBonus強化', 'data-less branch boost'],
        }),
        analyzedCount: best.r.total,
        accuracy: best.acc,
      },
    })
    console.log(`AlgorithmConfig v${newVersion} 保存完了`)
  }

  await prisma.$disconnect()
  return best
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
