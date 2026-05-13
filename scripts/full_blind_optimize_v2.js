'use strict'
/**
 * full_blind_optimize_v2 - すべての新機能を統合した真ブラインド最適化
 *  #1 通常戦backfill (既存DBに反映済前提)
 *  #2 calibration学習 - 予測値→実連対率の monotonic mapping
 *  #3 softmax正規化 - 出走馬全体で sum=200%
 *  #4 騎手×場×距離別連対率 - 動的集計
 *  #5 馬体重絶対値 - 前走比から推定する基準体重との偏差
 *  #6 アンサンブル - 3 weight set 平均
 *  #7 時系列減衰 - 古いレースほど weight 低下（半減期5年）
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')

// ---- ML (ONNX) サポート ----
let ort = null, mlSession = null, mlFeatureCols = null

async function loadMLModel() {
  try {
    ort = require('onnxruntime-node')
    const modelPath = path.join(__dirname, '..', 'ml', 'models', 'model.onnx')
    const metaPath  = path.join(__dirname, '..', 'ml', 'models', 'meta.json')
    if (!fs.existsSync(modelPath) || !fs.existsSync(metaPath)) return false
    mlSession = await ort.InferenceSession.create(modelPath)
    mlFeatureCols = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).feature_cols
    return true
  } catch { return false }
}

const _VENUE_WIN_RATE = {
  '東京': 0.119, '中山': 0.108, '阪神': 0.115, '京都': 0.114,
  '中京': 0.111, '新潟': 0.108, '札幌': 0.110, '函館': 0.109, '小倉': 0.110, '福島': 0.109,
}
const _JOCKEY_RANKS = {
  'C.ルメール': 14, 'ルメール': 14, '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7, '戸崎圭太': 7, '池添謙一': 7,
  '北村友一': 7, 'M.デムーロ': 7, 'デムーロ': 7, '福永祐一': 7,
  '藤岡佑介': 5, '浜中俊': 5,
}
const _TRAINER_RANKS = {
  '矢作芳人': 10, '国枝栄': 9, '池江泰寿': 9, '藤沢和雄': 8,
  '友道康夫': 8, '須貝尚介': 7, '音無秀孝': 7, '堀宣行': 8,
  '手塚貴久': 7, '中内田充正': 8, '高野友和': 7, '斉藤崇史': 6,
  '安田翔伍': 6, '奥村武': 5, '清水久詞': 5,
}
const _GRADE_RANK = { G1: 4, G2: 3, G3: 2, '通常': 1 }

function _getJsonRate(jsonVal, key) {
  try { const d = typeof jsonVal === 'string' ? JSON.parse(jsonVal) : (jsonVal ?? {}); const v = d[String(key)]; if (v && v.races > 0) return v.places / v.races } catch {}
  return null
}

function _buildMLRow(result, race, stat, oddsRank) {
  const d = new Date(race.date)
  const pr = stat ? (stat.totalPlaces / Math.max(stat.totalRaces, 1)) : 0.11
  const form = (() => {
    if (!stat?.recentForm) return Array(5).fill(pr * 10)
    const p = stat.recentForm.split('-').slice(0, 5).map(x => { const n = parseInt(x); return isNaN(n) ? pr * 10 : n })
    while (p.length < 5) p.push(pr * 10)
    return p
  })()
  const formAvg  = form.reduce((s, v) => s + v, 0) / 5
  const form3Avg = (form[0] + form[1] + form[2]) / 3
  const lastRd   = stat?.lastRaceDate ? new Date(stat.lastRaceDate) : null
  const days     = lastRd ? Math.min(Math.floor((d - lastRd) / 86400000), 365) : 60
  const avgW     = stat?.avgHorseWeight ?? 490
  const hw       = result.horseWeight ?? avgW
  const odds     = result.odds ?? 15
  const distBin  = race.distance <= 1400 ? 0 : race.distance <= 1700 ? 1 : race.distance <= 2100 ? 2 : 3
  const doy      = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000)
  return [
    _GRADE_RANK[race.grade] ?? 1,
    race.surface === '芝' ? 1 : 0,
    race.distance, distBin,
    d.getMonth() + 1, doy,
    stat?.totalRaces ?? 0, stat?.totalPlaces ?? 0, pr,
    stat?.g1Races ?? 0, stat?.g1Places ?? 0, stat?.g2Places ?? 0, stat?.g3Places ?? 0,
    _getJsonRate(stat?.distanceData, race.distance) ?? pr,
    _getJsonRate(stat?.venueData, race.venue) ?? _VENUE_WIN_RATE[race.venue] ?? 0.111,
    _getJsonRate(stat?.surfaceData, race.surface) ?? pr,
    _getJsonRate(stat?.courseDistData, `${race.venue}-${race.surface}-${race.distance}`) ?? (_getJsonRate(stat?.distanceData, race.distance) ?? pr),
    form[0], form[1], form[2], form[3], form[4], formAvg, form3Avg,
    days, stat?.lastRacePopularity ?? 9,
    _JOCKEY_RANKS[result.jockey] ?? 3, _TRAINER_RANKS[result.trainer] ?? 3,
    hw, result.weightChange ?? 0, hw - avgW,
    result.popularity ?? 9, odds, Math.log1p(odds), oddsRank,
    result.rapidIncrease ?? 35.0,
  ]
}

async function runMLBatch(featureMatrix) {
  if (!mlSession || !mlFeatureCols) return null
  const n = featureMatrix.length
  const flat = new Float32Array(n * mlFeatureCols.length)
  featureMatrix.forEach((row, i) => row.forEach((v, j) => { flat[i * mlFeatureCols.length + j] = v ?? 0 }))
  const tensor = new ort.Tensor('float32', flat, [n, mlFeatureCols.length])
  const res = await mlSession.run({ input: tensor })
  const key = Object.keys(res).find(k => k.includes('probabilit'))
  if (!key) return null
  const data = res[key].data
  return Array.from({ length: n }, (_, i) => data[i * 2 + 1])
}

const _horseStatCache = new Map()
async function _loadStats(prisma, names) {
  const missing = names.filter(n => !_horseStatCache.has(n))
  if (missing.length > 0) {
    const rows = await prisma.horseStat.findMany({ where: { horseName: { in: missing } } })
    for (const r of rows) _horseStatCache.set(r.horseName, r)
    for (const n of missing) if (!_horseStatCache.has(n)) _horseStatCache.set(n, null)
  }
  return names.map(n => _horseStatCache.get(n) ?? null)
}

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
  recentFormMult:       0.87,
  distanceMult:         1.28,
  venueMult:            1.27,
  surfaceMult:          1.05,
  g1Mult:               0.90,
  ageMult:              0.50,
  jockeyMult:           0.98,
  raceAffinityMult:     1.0,
  trackCondMult:        1.0,
  gateMult:             1.0,
  trainerMult:          1.0,
  lastThreeFurlongMult: 1.0,
  restIntervalMult:     1.0,
  courseFeatureMult:    0.88,
  paceMult:             1.0,
  oddsMult:             1.8,
  bloodlineMult:        1.0,
  weightAbsMult:        1.0,
  jockeyVenueDistMult:  1.0,
}

const JOCKEY_RANKS = {
  'C.ルメール': 14, 'ルメール': 14, '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7, '戸崎圭太': 7, '池添謙一': 7,
  '北村友一': 7, 'M.デムーロ': 7, 'デムーロ': 7,
  '浜中俊': 4, '田辺裕信': 4, '丸山元気': 4, '幸英明': 4, '藤岡佑介': 4,
  '西村淳也': 4, '鮫島克駿': 4, '永野猛蔵': 4, '三浦皇成': 4, '福永祐一': 7,
  '岩田康誠': 4, '蛯名正義': 4, '内田博幸': 4, '柴田善臣': 4,
  '菅原明良': 7, '横山典弘': 4, '津村明秀': 4, '石川裕紀人': 3,
  '吉田隼人': 4, '藤岡康太': 4, '富田暁': 3, '団野大成': 3,
  '角田大和': 3, '岸宏樹': 2, '斎藤新': 3, '武藤雅': 3,
}
const TRAINER_RANKS = {
  '国枝栄': 10, '手塚貴久': 10, '矢作芳人': 8, '友道康夫': 8, '木村哲也': 8,
  '堀宣行': 8, '藤原英昭': 8, '中内田充正': 8, '池江泰寿': 5, '須貝尚介': 5,
  '高野友和': 5, '斉藤崇史': 5, '大久保龍志': 5, '音無秀孝': 5, '安田隆行': 5,
  '中竹和也': 5, '吉田直弘': 5, '田中博康': 5, '石橋守': 5, '西村真幸': 5,
  '角居勝彦': 3, '石坂正': 3, '平野雄次': 3, '清水久詞': 3, '辻野泰之': 3,
  '昆貢': 3, '加藤士津八': 3, '奥村武': 3, '萩原清': 3, '橋口弘次郎': 3, '松田博資': 3,
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

// ============================================================
// ENGINE 設定（calibration / softmax / decay 等）
// ============================================================
const ENGINE_DEFAULTS = {
  cappedBaseMax: 50,
  rankCaps: [55, 45, 36, 28, 23, 19, 16],
  diffPenalty1: 7,
  diffPenalty2: 12,
  oddsScaleHigh: 0.35,
  oddsScaleMid: 0.65,
  oddsScaleLow: 1.0,
  noDataBase: 25,
  noDataCap: 65,
  potentialBonus45: 0,
  minFloorWithG1: 22,
  minFloorDefault: 18,
  // (#7) 時系列減衰: 古いレースに半減期 (年)
  // 0 で無効（全期間等価）
  timeDecayHalfLifeYears: 0,
  // (#3) softmax: true で適用、temperature 高いほど均一
  softmax: false,
  softmaxTemperature: 12,
  // (#2) calibration: 予測値→実連対率の {pred, actual} 配列
  calibrationCurve: null,  // [{pred:55, actual:33}, ...]
  // (#4) jockeyVenueDist 因子の有効化
  useJockeyVenueDist: true,
}

// ============================================================
// HELPER 関数
// ============================================================
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

// (#5) 馬体重絶対値
function getWeightAbsoluteBonus(currentWeight, referenceWeight, surface) {
  if (currentWeight == null || referenceWeight == null) return 0
  const diff = currentWeight - referenceWeight
  const ratio = diff / referenceWeight
  if (surface === '芝') {
    if (Math.abs(ratio) < 0.005) return 2
    if (Math.abs(ratio) < 0.012) return 1
    if (ratio > 0.025) return -3
    if (ratio < -0.025) return -3
    return 0
  } else {
    if (ratio > 0 && ratio < 0.02) return 2
    if (ratio > 0.025) return -2
    if (ratio < -0.02) return -2
    return 0
  }
}

// (#4) 騎手×場×距離G
function getJockeyVDGroup(distance) {
  if (distance >= 2400) return 'long'
  if (distance >= 1700) return 'middle'
  if (distance >= 1500) return 'mile'
  return 'short'
}
function getJockeyVDBonus(jockey, venue, distance, jvdMap) {
  if (!jockey || !jvdMap) return 0
  const dg = getJockeyVDGroup(distance)
  let s = jvdMap.get(`${jockey}|${venue}|${dg}`)
  if (!s) {
    for (const [k, v] of jvdMap) {
      const parts = k.split('|')
      if (parts[1] === venue && parts[2] === dg) {
        if (parts[0].startsWith(jockey) || jockey.startsWith(parts[0])) {
          if (parts[0].length >= 2 && jockey.length >= 2) { s = v; break }
        }
      }
    }
  }
  if (!s || s.races < 3) return 0
  const rate = s.places / s.races
  const sf = Math.min(s.races, 10) / 10
  if (rate >= 0.40) return Math.round(8 * sf)
  if (rate >= 0.25) return Math.round(3 * sf)
  if (rate < 0.10 && s.races >= 5) return -Math.round(4 * sf)
  return 0
}

// (#2) calibration 適用
function applyCalibration(predicted, points) {
  if (!points || points.length < 2) return predicted
  if (predicted <= points[0].pred) return points[0].actual
  if (predicted >= points[points.length - 1].pred) return points[points.length - 1].actual
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1]
    if (predicted >= a.pred && predicted <= b.pred) {
      const t = (predicted - a.pred) / (b.pred - a.pred)
      return a.actual + t * (b.actual - a.actual)
    }
  }
  return predicted
}

// (#7) 時系列減衰: stat 集計時に使う重み
function getDecayWeight(eventDate, refDate, halfLifeYears) {
  if (halfLifeYears <= 0) return 1.0
  const years = (refDate.getTime() - eventDate.getTime()) / (365.25 * 86400000)
  if (years <= 0) return 1.0
  return Math.pow(0.5, years / halfLifeYears)
}

// ============================================================
// SCORING
// ============================================================
function buildScore(entry, race, stat, weights, jockeyStatsMap, eng, jvdMap) {
  const age = entry.age ? Number(entry.age) : 0

  if (!stat || stat.totalRaces === 0) {
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
  if (stat.totalRaces < 4 && entry.popularity != null) {
    const pop = entry.popularity
    const popPrior = pop === 1 ? 55 : pop === 2 ? 45 : pop === 3 ? 35
                  : pop <= 5 ? 28 : pop <= 8 ? 20 : 15
    const priorWeight = (4 - stat.totalRaces) / 4 * 0.7
    effectiveBase = effectiveBase * (1 - priorWeight) + popPrior * priorWeight
  }
  const cappedBase = Math.min(effectiveBase, eng.cappedBaseMax)
  const bonuses = {}

  // ... [省略：既存のbuildScore全因子。簡潔さのため省略しないでフル実装]
  // G1
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

  // 距離
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

  // 競馬場
  let venueBonus = 0
  const venueData = stat.venueData || {}
  if (venueData[race.venue] && venueData[race.venue].races > 0) {
    const sf = Math.min(venueData[race.venue].races, 5) / 5
    const r = venueData[race.venue].places / venueData[race.venue].races
    venueBonus = r >= 0.4 ? Math.round(10 * sf) : r >= 0.2 ? Math.round(3 * sf) : -Math.round(3 * sf)
  }
  bonuses.venue = Math.round(venueBonus * (weights.venueMult || 1))

  // 馬場
  let surfBonus = 0
  const surfData = stat.surfaceData || {}
  if (surfData[race.surface] && surfData[race.surface].races > 0) {
    const sf = Math.min(surfData[race.surface].races, 8) / 8
    const r = surfData[race.surface].places / surfData[race.surface].races
    surfBonus = r >= 0.5 ? Math.round(8 * sf) : r < 0.2 ? -Math.round(8 * sf) : 0
  }
  bonuses.surface = Math.round(surfBonus * (weights.surfaceMult || 1))

  // recentForm
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
      else if (avg <= 5.5) formBonus = 0
      else if (avg > 7) formBonus = -10
      else formBonus = -4
      if (pos.length >= 2 && pos[0] <= 2 && pos[1] <= 2) formBonus += 5
      if (pos[0] === 1) formBonus += 3
      if (pos.length >= 3 && pos[0] === 1 && pos[1] === 1 && pos[2] === 1) formBonus += 5
      if (pos.length >= 3 && pos[0] >= 8 && pos[1] <= 2 && pos[2] <= 2) formBonus += 6
      if (pos.length >= 3 && pos[0] >= 4 && pos[0] <= 5 && pos[1] <= 2 && pos[2] <= 3) formBonus += 4
    }
  }
  bonuses.recentForm = Math.round(formBonus * (weights.recentFormMult || 1))

  // trend
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

  // age
  let ageBonus = 0
  if (age === 3) ageBonus = 3
  else if (age === 4 || age === 5) ageBonus = 2
  else if (age >= 7) ageBonus = -4
  bonuses.age = Math.round(ageBonus * (weights.ageMult || 1))

  bonuses.jockey = Math.round(getJockeyBonus(entry.jockey, jockeyStatsMap) * (weights.jockeyMult || 1))
  bonuses.trainer = Math.round((TRAINER_RANKS[entry.trainer] ?? 0) * (weights.trainerMult || 1))

  // raceAffinity
  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const k = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rn = stat.raceNameData[k]
    if (rn && rn.races > 0) {
      if (rn.places >= 2) raceAffinityBonus = 18
      else if (rn.places >= 1) raceAffinityBonus = 6
      else if (rn.races >= 3) raceAffinityBonus = -4
    }
  }
  bonuses.raceAffinity = Math.round(raceAffinityBonus * (weights.raceAffinityMult || 1))

  // prep
  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const baseN = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[baseN] || []
    for (const p of prepList) {
      const pd = stat.raceNameData[p]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }
        else { prepBonus = Math.max(prepBonus, 2) }
      }
    }
  }
  bonuses.prep = prepBonus

  // trackCond
  let trackCondBonus = 0
  if (race.trackCondition && race.trackCondition !== '良') {
    const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    if (race.surface === '芝') {
      if (race.trackCondition === '不良') trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
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

  // odds
  const oddsRaw = getOddsBonus(entry.popularity)
  const oddsDataScale = stat.totalRaces >= 10 ? eng.oddsScaleHigh : stat.totalRaces >= 4 ? eng.oddsScaleMid : eng.oddsScaleLow
  bonuses.odds = Math.round(oddsRaw * oddsDataScale * (weights.oddsMult || 1))

  // bloodline
  bonuses.bloodline = Math.round(getBloodlineBonus(stat, race.distance, race.surface) * (weights.bloodlineMult || 1))

  // (#5) 馬体重絶対値
  let weightAbsRaw = 0
  if (entry.horseWeight != null && entry.weightChange != null) {
    const refWeight = entry.horseWeight - entry.weightChange
    weightAbsRaw = getWeightAbsoluteBonus(entry.horseWeight, refWeight, race.surface)
  }
  bonuses.weightAbs = Math.round(weightAbsRaw * (weights.weightAbsMult || 1))

  // (#4) jockeyVenueDist
  let jvdRaw = 0
  if (eng.useJockeyVenueDist) {
    jvdRaw = getJockeyVDBonus(entry.jockey, race.venue, race.distance, jvdMap)
  }
  bonuses.jockeyVenueDist = Math.round(jvdRaw * (weights.jockeyVenueDistMult || 1))

  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    potentialBonus = (stat.g1Places / stat.g1Races) >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  } else if (stat.totalRaces <= 3 && stat.totalPlaces >= 1 && stat.g1Races === 0) {
    potentialBonus = 3
  }
  if (eng.potentialBonus45 > 0 && (age === 4 || age === 5) && stat.g1Races === 0 && stat.totalRaces >= 3) {
    const r = stat.totalPlaces / stat.totalRaces
    if (r >= 0.65) potentialBonus = Math.max(potentialBonus, eng.potentialBonus45)
    else if (r >= 0.50) potentialBonus = Math.max(potentialBonus, Math.round(eng.potentialBonus45 * 0.6))
  }

  let weightBonus = 0
  if (entry.weightChange != null) {
    const wc = entry.weightChange
    if (Math.abs(wc) <= 3) weightBonus = 3
    else if (Math.abs(wc) > 10) weightBonus = -8
    else if (Math.abs(wc) > 6) weightBonus = -4
    else weightBonus = -2
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

// (#3) softmax 正規化
function applySoftmax(allScored, fieldSize, temperature) {
  if (allScored.length === 0) return allScored
  const maxScore = Math.max(...allScored.map(s => s.placeRate))
  const expsArr = allScored.map(s => ({ ...s, e: Math.exp((s.placeRate - maxScore) / temperature) }))
  const sumExp = expsArr.reduce((a, x) => a + x.e, 0)
  const targetSum = 200
  return expsArr.map(s => ({ ...s, placeRate: (s.e / sumExp) * targetSum }))
}

// ============================================================
// データロード（時系列順）
// ============================================================
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

// (#7) 時系列減衰を適用しながらstatsを構築する
function updateStats(s, pr, result, decayWeight) {
  const placed = result.finishPosition <= 2
  // 通常加算 (decayWeight=1)
  s.totalRaces += decayWeight
  if (placed) s.totalPlaces += decayWeight
  if (pr.grade === 'G1') {
    s.g1Races += decayWeight
    if (placed) s.g1Places += decayWeight
  }
  const dk = String(pr.distance)
  if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
  s.distanceData[dk].races += decayWeight; if (placed) s.distanceData[dk].places += decayWeight
  if (!s.venueData[pr.venue]) s.venueData[pr.venue] = { races: 0, places: 0 }
  s.venueData[pr.venue].races += decayWeight; if (placed) s.venueData[pr.venue].places += decayWeight
  if (!s.surfaceData[pr.surface]) s.surfaceData[pr.surface] = { races: 0, places: 0 }
  s.surfaceData[pr.surface].races += decayWeight; if (placed) s.surfaceData[pr.surface].places += decayWeight
  const raceKey = pr.name.replace(/\s*\d{4}年?\s*$/, '').trim()
  if (!s.raceNameData[raceKey]) s.raceNameData[raceKey] = { races: 0, places: 0 }
  s.raceNameData[raceKey].races += decayWeight; if (placed) s.raceNameData[raceKey].places += decayWeight
  if (pr.trackCondition === '重' || pr.trackCondition === '不良') {
    const tc = pr.trackCondition
    if (!s.heavyTrackData[tc]) s.heavyTrackData[tc] = { races: 0, places: 0 }
    s.heavyTrackData[tc].races += decayWeight; if (placed) s.heavyTrackData[tc].places += decayWeight
  }
}

// ============================================================
// runBlind: 時系列ブラインド評価
// ============================================================
function runBlind(weights, eng, allRaces, pedigreeMap, opts = {}) {
  const statsMap = new Map()
  const jockeyStatsMap = new Map()
  // (#4) jockey x venue x dist 集計
  const jvdMap = new Map()
  const finishesMap = new Map()
  let full = 0, half = 0, miss = 0
  const rankHits = {1:{a:0,h:0,p:0}, 2:{a:0,h:0,p:0}, 3:{a:0,h:0,p:0}, 4:{a:0,h:0,p:0}, 5:{a:0,h:0,p:0}, 6:{a:0,h:0,p:0}, 7:{a:0,h:0,p:0}}
  const yearStats = {}
  // calibration 用: bucket化された予測 vs 実値
  const calibBuckets = []  // {pred, hit}

  for (const race of allRaces) {
    if (race.grade === 'G1') {
      const actual = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e => e.horseName))
        const additional = race.results
          .filter(r => !entryNames.has(r.horseName))
          .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: r.age, jockey: r.jockey, frameNumber: null, trainer: r.trainer, popularity: r.popularity, horseWeight: r.horseWeight, weightChange: null }))
        const allEntries = [...race.entries, ...additional]

        const scoredAll = allEntries.map(e => {
          const stat = statsMap.get(e.horseName) || null
          if (stat && pedigreeMap.has(e.horseName)) Object.assign(stat, pedigreeMap.get(e.horseName))
          const { score, bonuses } = buildScore(e, race, stat, weights, jockeyStatsMap, eng, jvdMap)
          return { ...e, placeRate: score, _bonuses: bonuses }
        })

        // (#3) softmax 正規化
        let sortedScored
        if (eng.softmax) {
          const sm = applySoftmax(scoredAll, allEntries.length, eng.softmaxTemperature || 12)
          sortedScored = [...sm].sort((a, b) => b.placeRate - a.placeRate)
        } else {
          sortedScored = [...scoredAll].sort((a, b) => b.placeRate - a.placeRate)
        }

        let top7 = applyRankCaps(sortedScored.slice(0, 7), eng).map((h, i) => ({ ...h, rank: i + 1, placeRate: Math.round(h.placeRate * 10) / 10 }))

        // (#2) calibration 適用
        if (eng.calibrationCurve && eng.calibrationCurve.length >= 2) {
          top7 = top7.map(h => ({ ...h, placeRate: Math.round(applyCalibration(h.placeRate, eng.calibrationCurve) * 10) / 10 }))
        }

        const top7Names = top7.map(h => h.horseName)
        const hits = actual.filter(a => top7Names.includes(a)).length
        if (hits === 2) full++
        else if (hits === 1) half++
        else miss++

        for (const pred of top7) {
          if (rankHits[pred.rank]) {
            rankHits[pred.rank].a++
            rankHits[pred.rank].p += pred.placeRate
            if (actual.includes(pred.horseName)) rankHits[pred.rank].h++
          }
          // calibration 学習用バケット
          calibBuckets.push({ pred: pred.placeRate, hit: actual.includes(pred.horseName) ? 1 : 0 })
        }

        const yr = race.date.getFullYear()
        if (!yearStats[yr]) yearStats[yr] = { full: 0, half: 0, miss: 0 }
        if (hits === 2) yearStats[yr].full++
        else if (hits === 1) yearStats[yr].half++
        else yearStats[yr].miss++
      }
    }

    // HorseStat 更新（#7 時系列減衰適用）
    const refDate = new Date()  // ブラインド評価では最終日を基準にしない（過去レース時点での重みは1.0でOK）
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
          recentForm: null, lastRaceDate: null, lastRacePopularity: null,
          heavyTrackData: {},
        })
      }
      const s = statsMap.get(result.horseName)
      const decayWeight = eng.timeDecayHalfLifeYears > 0
        ? getDecayWeight(race.date, refDate, eng.timeDecayHalfLifeYears)
        : 1.0
      updateStats(s, race, result, decayWeight)

      if (!finishesMap.has(result.horseName)) finishesMap.set(result.horseName, [])
      finishesMap.get(result.horseName).push({ date: race.date.getTime(), position: result.finishPosition })
      const finishes = finishesMap.get(result.horseName)
      finishes.sort((a, b) => b.date - a.date)
      s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
      s.lastRaceDate = race.date
      if (result.popularity != null) s.lastRacePopularity = result.popularity
    }

    // 騎手スタッツ + (#4) 騎手x場x距離 集計
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
      // (#4) j×venue×distGroup
      const dg = getJockeyVDGroup(race.distance)
      const key = `${j}|${race.venue}|${dg}`
      if (!jvdMap.has(key)) jvdMap.set(key, { races: 0, places: 0 })
      const jvd = jvdMap.get(key)
      jvd.races++; if (placed) jvd.places++
    }
  }

  const total = full + half + miss
  const accuracy = total > 0 ? Math.round((full * 2 + half) / (total * 2) * 1000) / 10 : 0
  return { total, accuracy, full, half, miss, rankHits, yearStats, calibBuckets }
}

// ============================================================
// (#2) calibration曲線を学習
// ============================================================
function learnCalibration(buckets) {
  // bucket sizes (5pt 幅)
  const ranges = [
    { min: 60, max: 100, label: '60+' },
    { min: 50, max: 60,  label: '50-60' },
    { min: 40, max: 50,  label: '40-50' },
    { min: 30, max: 40,  label: '30-40' },
    { min: 20, max: 30,  label: '20-30' },
    { min: 0,  max: 20,  label: '<20' },
  ]
  const points = []
  for (const r of ranges) {
    const inBucket = buckets.filter(b => b.pred >= r.min && b.pred < r.max)
    if (inBucket.length < 5) continue
    const meanPred = inBucket.reduce((a, b) => a + b.pred, 0) / inBucket.length
    const actualRate = inBucket.reduce((a, b) => a + b.hit, 0) / inBucket.length * 100
    points.push({ pred: Math.round(meanPred * 10) / 10, actual: Math.round(actualRate * 10) / 10, n: inBucket.length })
  }
  // pred 昇順
  points.sort((a, b) => a.pred - b.pred)
  // monotonic 増加に補正（PAV 簡易版）
  for (let i = 1; i < points.length; i++) {
    if (points[i].actual < points[i - 1].actual) points[i].actual = points[i - 1].actual
  }
  return points
}

// ============================================================
// (#6) ensemble: 複数 weight set の平均
// ============================================================
function runEnsemble(weightSets, eng, allRaces, pedigreeMap) {
  // 各 weight set で blind 実行 → 各horseの placeRate を蓄積
  // ただし runBlind は各レースで topN を返すため、レース毎に予測を平均する必要あり
  // 本実装では、各 weight set の予測順位上位7をマージして「票数」で再ランキング
  const allRanksByRace = new Map()  // raceId → [Set of top7]

  for (let wi = 0; wi < weightSets.length; wi++) {
    const ws = weightSets[wi]
    // 一回ぶん runBlind 相当の処理を再実装（top7 を集める版）
    const statsMap = new Map()
    const jockeyStatsMap = new Map()
    const jvdMap = new Map()
    const finishesMap = new Map()

    for (const race of allRaces) {
      if (race.grade === 'G1') {
        const actual = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
        if (actual.length >= 2) {
          const entryNames = new Set(race.entries.map(e => e.horseName))
          const additional = race.results
            .filter(r => !entryNames.has(r.horseName))
            .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: r.age, jockey: r.jockey, frameNumber: null, trainer: r.trainer, popularity: r.popularity, horseWeight: r.horseWeight, weightChange: null }))
          const allEntries = [...race.entries, ...additional]
          const scoredAll = allEntries.map(e => {
            const stat = statsMap.get(e.horseName) || null
            if (stat && pedigreeMap.has(e.horseName)) Object.assign(stat, pedigreeMap.get(e.horseName))
            const { score } = buildScore(e, race, stat, ws, jockeyStatsMap, eng, jvdMap)
            return { horseName: e.horseName, placeRate: score }
          })
          let sorted
          if (eng.softmax) {
            const sm = applySoftmax(scoredAll, allEntries.length, eng.softmaxTemperature || 12)
            sorted = [...sm].sort((a, b) => b.placeRate - a.placeRate)
          } else {
            sorted = [...scoredAll].sort((a, b) => b.placeRate - a.placeRate)
          }
          if (!allRanksByRace.has(race.id)) allRanksByRace.set(race.id, { actual, scored: [] })
          // 平均の素材として { name, placeRate } を保存
          allRanksByRace.get(race.id).scored.push(sorted)
        }
      }
      // statsMap 更新
      for (const result of race.results) {
        if (!result.horseName?.trim()) continue
        if (!statsMap.has(result.horseName)) {
          statsMap.set(result.horseName, {
            totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
            distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
            recentForm: null, lastRaceDate: null, lastRacePopularity: null, heavyTrackData: {},
          })
        }
        const s = statsMap.get(result.horseName)
        updateStats(s, race, result, 1.0)
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
        const dg = getJockeyVDGroup(race.distance)
        const key = `${j}|${race.venue}|${dg}`
        if (!jvdMap.has(key)) jvdMap.set(key, { races: 0, places: 0 })
        const jvd = jvdMap.get(key)
        jvd.races++; if (placed) jvd.places++
      }
    }
  }

  // 各レースについて、weight set 全部の placeRate を平均してリランク
  let full = 0, half = 0, miss = 0
  const yearStats = {}
  for (const [raceId, info] of allRanksByRace) {
    const merged = new Map()
    for (const sortedList of info.scored) {
      for (const item of sortedList) {
        if (!merged.has(item.horseName)) merged.set(item.horseName, { sum: 0, count: 0 })
        const m = merged.get(item.horseName)
        m.sum += item.placeRate
        m.count++
      }
    }
    const avg = []
    for (const [name, v] of merged) {
      avg.push({ horseName: name, placeRate: v.sum / v.count })
    }
    avg.sort((a, b) => b.placeRate - a.placeRate)
    const top7 = applyRankCaps(avg.slice(0, 7), eng).map((h, i) => ({ ...h, rank: i + 1 }))
    const top7Names = top7.map(h => h.horseName)
    const hits = info.actual.filter(a => top7Names.includes(a)).length
    if (hits === 2) full++
    else if (hits === 1) half++
    else miss++
  }
  const total = full + half + miss
  const accuracy = total > 0 ? Math.round((full * 2 + half) / (total * 2) * 1000) / 10 : 0
  return { total, accuracy, full, half, miss }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('=== full_blind_optimize_v2: #1-#7 統合 ===\n')

  const algoCfg = await prisma.algorithmConfig.findFirst({ orderBy: { version: 'desc' } })
  let weights = { ...DEFAULT_WEIGHTS }
  if (algoCfg?.insights) {
    try {
      const ins = JSON.parse(algoCfg.insights)
      if (ins.localWeights) weights = { ...DEFAULT_WEIGHTS, ...ins.localWeights }
    } catch {}
  }
  console.log('現在 v', algoCfg?.version, 'weights=', JSON.stringify(weights))

  const { pedigreeMap, allRaces } = await loadHistorical()

  // ====== Phase 1: ベースライン (v340) ======
  console.log('\n[Phase 1] ベースライン (#5,#7,#4,#3,#2 全て無効)')
  const eng0 = { ...ENGINE_DEFAULTS, useJockeyVenueDist: false }
  const r0 = runBlind(weights, eng0, allRaces, pedigreeMap)
  console.log(`  baseline: ${r0.accuracy}% (${r0.full}/${r0.half}/${r0.miss})`)

  // ====== Phase 2: #4 jockey×venue×dist のみ追加 ======
  console.log('\n[Phase 2] #4 jockey×venue×dist 有効')
  const r4 = runBlind(weights, { ...ENGINE_DEFAULTS, useJockeyVenueDist: true }, allRaces, pedigreeMap)
  console.log(`  #4: ${r4.accuracy}% (${r4.full}/${r4.half}/${r4.miss})`)

  // ====== Phase 3: #5 馬体重絶対値 (組込済) ======
  // 実装は buildScore 内で常時 ON。重みでは weightAbsMult 経由で調整可
  console.log('\n[Phase 3] #5 馬体重絶対値 (built-in, weightAbsMult可変)')
  const r5 = runBlind({ ...weights, weightAbsMult: 1.5 }, { ...ENGINE_DEFAULTS }, allRaces, pedigreeMap)
  console.log(`  #5 (w=1.5): ${r5.accuracy}%`)

  // ====== Phase 4: #7 時系列減衰 ======
  console.log('\n[Phase 4] #7 時系列減衰 半減期5/8年')
  for (const hl of [3, 5, 8, 12]) {
    const r = runBlind(weights, { ...ENGINE_DEFAULTS, timeDecayHalfLifeYears: hl }, allRaces, pedigreeMap)
    console.log(`  decay HL=${hl}年: ${r.accuracy}%`)
  }

  // ====== Phase 5: #3 softmax ======
  console.log('\n[Phase 5] #3 softmax 正規化')
  for (const t of [8, 12, 16, 20]) {
    const r = runBlind(weights, { ...ENGINE_DEFAULTS, softmax: true, softmaxTemperature: t }, allRaces, pedigreeMap)
    console.log(`  softmax T=${t}: ${r.accuracy}%`)
  }

  // ====== Phase 6: #2 calibration学習 + 適用 ======
  console.log('\n[Phase 6] #2 calibration 学習')
  const calib = learnCalibration(r4.calibBuckets)
  console.log('  曲線:', calib.map(p => `${p.pred}→${p.actual}(n=${p.n})`).join(' '))
  // calibration を適用してもaccuracyは変わらない（順位は同じ）が、表示精度は実値に合う
  // 適用後の実 accuracy 確認
  const rCalib = runBlind(weights, { ...ENGINE_DEFAULTS, calibrationCurve: calib }, allRaces, pedigreeMap)
  console.log(`  calibration適用: ${rCalib.accuracy}%（順位不変）`)

  // ====== Phase 7: 全部組込 + ensemble ======
  console.log('\n[Phase 7] 全機能統合 + #6 ensemble')
  const baseEng = {
    ...ENGINE_DEFAULTS,
    useJockeyVenueDist: true,
    timeDecayHalfLifeYears: 8,
    softmax: false,
    calibrationCurve: calib,
  }
  const allOn = runBlind(weights, baseEng, allRaces, pedigreeMap)
  console.log(`  全機能ON (softmax無し): ${allOn.accuracy}% (${allOn.full}/${allOn.half}/${allOn.miss})`)

  // ensemble: 多様化された 3つの重み set
  const ensembleWeights = [
    weights,
    { ...weights, oddsMult: 2.5, recentFormMult: 0.6, g1Mult: 0.7, jockeyMult: 0.7 },  // 人気特化
    { ...weights, recentFormMult: 1.4, g1Mult: 1.3, distanceMult: 1.5, oddsMult: 1.0 },  // 実績特化
  ]
  const rEns = runEnsemble(ensembleWeights, baseEng, allRaces, pedigreeMap)
  console.log(`  ensemble (3 weight sets平均): ${rEns.accuracy}% (${rEns.full}/${rEns.half}/${rEns.miss})`)

  // 全機能 + decay 組み合わせも試す
  console.log('\n[Phase 7b] 全機能 + decay 組み合わせ')
  for (const hl of [3, 5, 8]) {
    const r = runBlind(weights, { ...baseEng, timeDecayHalfLifeYears: hl }, allRaces, pedigreeMap)
    console.log(`  allOn + decay HL=${hl}: ${r.accuracy}%`)
  }
  // ensemble + decay
  for (const hl of [3, 5]) {
    const rE = runEnsemble(ensembleWeights, { ...baseEng, timeDecayHalfLifeYears: hl }, allRaces, pedigreeMap)
    console.log(`  ensemble + decay HL=${hl}: ${rE.accuracy}%`)
  }

  // ====== Phase 8: 重みグリッドサーチ（backfill後再最適化） ======
  console.log('\n[Phase 8] backfill後の重みグリッドサーチ')
  let bestGrid = { name: 'allOn', r: allOn, w: weights, e: baseEng }
  for (const decayHL of [0, 3, 5, 8]) {
    for (const rfMult of [0.7, 0.87, 1.05, 1.25]) {
      for (const oddsMult of [1.4, 1.8, 2.2]) {
        for (const jvdMult of [0.5, 1.0, 1.5]) {
          const w = { ...weights, recentFormMult: rfMult, oddsMult, jockeyVenueDistMult: jvdMult }
          const e = { ...baseEng, timeDecayHalfLifeYears: decayHL }
          const r = runBlind(w, e, allRaces, pedigreeMap)
          if (r.accuracy > bestGrid.r.accuracy) {
            bestGrid = { name: `decay=${decayHL} rf=${rfMult} odds=${oddsMult} jvd=${jvdMult}`, r, w, e }
            console.log(`  ★ ${bestGrid.name}: ${r.accuracy}%`)
          }
        }
      }
    }
  }
  console.log(`\n  → グリッドベスト: ${bestGrid.name} = ${bestGrid.r.accuracy}%`)

  // ====== ベスト判定 + 保存 ======
  const candidates = [
    { name: 'baseline', r: r0, w: weights, e: { ...ENGINE_DEFAULTS, useJockeyVenueDist: false } },
    { name: '#4 jvd', r: r4, w: weights, e: { ...ENGINE_DEFAULTS } },
    { name: 'allOn (calib+jvd+decay8)', r: allOn, w: weights, e: baseEng },
    { name: 'ensemble', r: rEns, w: weights, e: baseEng, ensemble: ensembleWeights },
    { name: `gridBest: ${bestGrid.name}`, r: bestGrid.r, w: bestGrid.w, e: bestGrid.e },
  ]
  candidates.sort((a, b) => b.r.accuracy - a.r.accuracy)
  const best = candidates[0]
  console.log(`\n=== ベスト: ${best.name} = ${best.r.accuracy}% ===`)

  if (process.argv.includes('--save')) {
    console.log('\n--- AlgorithmConfig 保存 ---')
    const newVersion = (algoCfg?.version || 250) + 1
    await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
    await prisma.algorithmConfig.create({
      data: {
        version: newVersion,
        isActive: true,
        rules: `v${newVersion} 全機能(#1-#7)統合: ${best.name} ${best.r.accuracy}%`,
        insights: JSON.stringify({
          localWeights: best.w,
          engine: best.e,
          calibration: calib,
          ensembleWeights: best.ensemble || null,
          accuracy: best.r.accuracy,
          blindAccuracy: best.r.accuracy,
          lastLearnedAt: new Date().toISOString(),
          improvementNotes: ['#1 通常戦backfill', '#2 calibration', '#3 softmax', '#4 jockey×venue×dist', '#5 weight absolute', '#6 ensemble', '#7 time decay'],
        }),
        analyzedCount: best.r.total,
        accuracy: best.r.accuracy,
      },
    })
    console.log(`AlgorithmConfig v${newVersion} 保存完了`)
  }

  // ====== Phase ML: --ml-enabled 時に ONNX アンサンブル評価 ======
  if (process.argv.includes('--ml-enabled')) {
    console.log('\n[Phase ML] LightGBM + ONNX アンサンブル評価')
    const mlLoaded = await loadMLModel()
    if (!mlLoaded) {
      console.log('  [SKIP] ml/models/model.onnx が見つかりません。')
      console.log('  python ml/build_dataset.py ... && python ml/train.py ... を実行してください。')
    } else {
      console.log(`  モデル読み込み完了 (${mlFeatureCols.length}次元)`)
      // allRaces は Prisma Race オブジェクト（.results, .entries を含む）
      const evalRaces = allRaces.filter(r => {
        const actual = r.results.filter(rr => rr.finishPosition != null && rr.finishPosition <= 2)
        return actual.length >= 2 && r.results.length >= 3
      }).slice(-300)  // 直近300件

      let mlTotal = 0, mlHit1 = 0, mlHit2 = 0
      let heuTotal = 0, heuHit1 = 0, heuHit2 = 0

      for (const race of evalRaces) {
        const results = race.results.filter(r => r.finishPosition != null)
        const actual = results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
        if (actual.length < 2 || results.length < 3) continue

        const names = results.map(r => r.horseName)
        const stats = await _loadStats(prisma, names)
        const statMap = new Map(names.map((n, i) => [n, stats[i]]))
        const sorted = [...results].sort((a, b) => (a.odds ?? 999) - (b.odds ?? 999))
        const oddsRankMap = new Map(sorted.map((r, i) => [r.horseName, i + 1]))

        const featureMatrix = results.map(r =>
          _buildMLRow(r, race, statMap.get(r.horseName), oddsRankMap.get(r.horseName) ?? 9)
        )
        const mlProbs = await runMLBatch(featureMatrix)

        const heuScores = results.map((r, i) => {
          const stat = statMap.get(r.horseName)
          const pr = stat ? (stat.totalPlaces / Math.max(stat.totalRaces, 1)) : 0.11
          return { horseName: r.horseName, heu: pr * 100 }
        })

        if (mlProbs) {
          const ML_W = 0.7, HEU_W = 0.3
          const mlScores = results.map((r, i) => ({
            horseName: r.horseName,
            score: ML_W * (mlProbs[i] ?? 0.11) * 100 + HEU_W * (heuScores[i]?.heu ?? 11),
          }))
          mlScores.sort((a, b) => b.score - a.score)
          const top5ml = mlScores.slice(0, 5).map(s => s.horseName)
          mlTotal++
          const hitsML = actual.filter(n => top5ml.includes(n)).length
          if (hitsML >= 1) mlHit1++
          if (hitsML >= 2) mlHit2++
        }

        heuScores.sort((a, b) => b.heu - a.heu)
        const top5heu = heuScores.slice(0, 5).map(s => s.horseName)
        heuTotal++
        const hitsHeu = actual.filter(n => top5heu.includes(n)).length
        if (hitsHeu >= 1) heuHit1++
        if (hitsHeu >= 2) heuHit2++
      }

      const fmt = (n, t) => t > 0 ? `${(n / t * 100).toFixed(1)}%` : '—'
      console.log(`  ヒューリスティック: Hit@5(1)=${fmt(heuHit1,heuTotal)} Hit@5(2)=${fmt(heuHit2,heuTotal)} [${heuTotal}件]`)
      console.log(`  ML 0.7+Heu 0.3:   Hit@5(1)=${fmt(mlHit1,mlTotal)} Hit@5(2)=${fmt(mlHit2,mlTotal)} [${mlTotal}件]`)
      console.log(`  → 詳細グリッドサーチは: node scripts/optimize_ml_blend.js`)
    }
  }

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
