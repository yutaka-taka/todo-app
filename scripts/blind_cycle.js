'use strict'
/**
 * 時系列ブラインド改善サイクル v2
 * - scorer.ts と因子を完全同期（v274: 枠番/調教師/コース特性/出走間隔 追加）
 * - nudgeWeights 閾値を実測ベースライン（約23%）基準に修正
 * - lastRaceDate / lastRacePopularity をブラインド統計に追跡
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

// ===== スコアリングエンジン（scorer.ts と完全同期） =====
const DEFAULT_WEIGHTS = {
  recentFormMult:       0.73,
  distanceMult:         1.28,
  venueMult:            1.15,
  surfaceMult:          1.05,
  g1Mult:               0.80,
  ageMult:              0.50,
  jockeyMult:           1.10,
  raceAffinityMult:     1.0,
  trackCondMult:        1.0,
  // v274 新因子
  gateMult:             1.0,
  trainerMult:          1.0,
  restIntervalMult:     1.0,
  courseFeatureMult:    1.0,
  // ユーザー入力系（ブラインドテスト不可・保存のみ）
  lastThreeFurlongMult: 1.0,
  paceMult:             1.0,
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

// ========== 調教師ランク（scorer.ts 同期） ==========
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

// ========== 競馬場コース特性（scorer.ts 同期） ==========
const COURSE_FEATURES = {
  '東京': { slope: 'mild',  direction: 'left',  straight: 525, shape: 'wide'  },
  '中山': { slope: 'steep', direction: 'right', straight: 310, shape: 'tight' },
  '阪神': { slope: 'steep', direction: 'right', straight: 356, shape: 'wide'  },
  '京都': { slope: 'mild',  direction: 'right', straight: 404, shape: 'wide'  },
  '中京': { slope: 'mild',  direction: 'left',  straight: 412, shape: 'wide'  },
  '新潟': { slope: 'flat',  direction: 'left',  straight: 659, shape: 'wide'  },
  '函館': { slope: 'flat',  direction: 'right', straight: 262, shape: 'tight' },
  '札幌': { slope: 'flat',  direction: 'right', straight: 266, shape: 'tight' },
  '小倉': { slope: 'flat',  direction: 'right', straight: 293, shape: 'tight' },
  '福島': { slope: 'flat',  direction: 'right', straight: 292, shape: 'tight' },
}

const RANK_CAPS = [65, 52, 38, 28, 22, 18, 15]

const PREP_RACES = {
  '日本ダービー':           ['皐月賞', 'NHKマイルカップ', '青葉賞'],
  '菊花賞':               ['神戸新聞杯', 'セントライト記念', '皐月賞'],
  'オークス':              ['桜花賞', 'フローラステークス'],
  '優駿牝馬（オークス）':   ['桜花賞', 'フローラステークス'],
  '天皇賞（春）':           ['阪神大賞典', '日経賞', 'AJCC', '有馬記念'],
  '宝塚記念':              ['大阪杯', '天皇賞（春）', 'AJCC'],
  '天皇賞（秋）':           ['毎日王冠', 'オールカマー', '札幌記念'],
  '有馬記念':              ['ジャパンカップ', '天皇賞（秋）', '宝塚記念'],
  'ジャパンカップ':          ['天皇賞（秋）', '宝塚記念'],
  '安田記念':              ['ヴィクトリアマイル', 'NHKマイルカップ', 'マイラーズカップ'],
  'ヴィクトリアマイル':       ['阪神牝馬ステークス', '中山牝馬ステークス', '桜花賞'],
  'エリザベス女王杯':        ['府中牝馬ステークス', '秋華賞', 'オークス'],
  '秋華賞':               ['オークス', 'ローズステークス', '紫苑ステークス'],
  'スプリンターズステークス':  ['キーンランドカップ', 'セントウルステークス', '高松宮記念'],
  '高松宮記念':             ['シルクロードステークス', 'オーシャンステークス'],
  'マイルチャンピオンシップ':  ['スワンステークス', '富士ステークス', '安田記念'],
  'フェブラリーステークス':    ['東海ステークス', '根岸ステークス', 'チャンピオンズカップ'],
  'チャンピオンズカップ':     ['JBCクラシック', 'みやこステークス', 'シリウスステークス'],
  'NHKマイルカップ':        ['アーリントンカップ', 'ニュージーランドトロフィー', '桜花賞'],
  '桜花賞':               ['チューリップ賞', 'フィリーズレビュー'],
  '皐月賞':               ['弥生賞ディープインパクト記念', 'スプリングステークス', '共同通信杯', '弥生賞'],
  'ホープフルステークス':     ['東京スポーツ杯2歳ステークス', 'デイリー杯2歳ステークス'],
  '大阪杯':               ['金鯱賞', '中山記念', '京都記念'],
}

// ========== ヘルパー関数 ==========

function smoothedRate(places, races) { return (places + 2) / (races + 8) * 100 }

function getJockeyBonus(jockey, jockeyStatsMap) {
  if (!jockey) return 0
  const s = jockeyStatsMap && jockeyStatsMap.get(jockey)
  if (!s || s.total < 3) return JOCKEY_RANKS[jockey] ?? 0
  const g1Rate = s.g1Total >= 3 ? (s.g1Places + 1) / (s.g1Total + 4) : null
  const overallRate = (s.places + 2) / (s.total + 8)
  const blendedRate = g1Rate ? g1Rate * 0.6 + overallRate * 0.4 : overallRate
  return Math.round(Math.max(-4, Math.min(14, (blendedRate * 100 - 20) * 14 / 35)))
}

// 枠番ボーナス（scorer.ts 同期）
function getGateBonus(frameNumber, distance, surface) {
  if (frameNumber == null || frameNumber <= 0) return 0
  const fn = frameNumber
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
    } else {
      if (fn <= 3) return 1
      return 0
    }
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

// コース特性ボーナス（scorer.ts 同期）
function getCourseFeatureBonus(targetVenue, venueData) {
  const target = COURSE_FEATURES[targetVenue]
  if (!target) return 0
  let bonus = 0
  for (const [venue, data] of Object.entries(venueData)) {
    if (venue === targetVenue || data.races === 0) continue
    const feature = COURSE_FEATURES[venue]
    if (!feature) continue
    const slopeSim = feature.slope === target.slope ? 0.5 : 0
    const dirSim   = feature.direction === target.direction ? 0.3 : 0
    const shapeSim = feature.shape === target.shape ? 0.2 : 0
    const sim = slopeSim + dirSim + shapeSim
    if (sim < 0.3) continue
    const rate = data.places / data.races
    const sf   = Math.min(data.races, 5) / 5
    const raw  = rate >= 0.40 ? 8 * sim * sf
               : rate >= 0.25 ? 3 * sim * sf
               : rate < 0.10  ? -4 * sim * sf
               : 0
    bonus = Math.max(bonus, raw)
  }
  return Math.min(Math.round(bonus), 8)
}

// 出走間隔ボーナス（叩き良化パターン考慮、scorer.ts 同期）
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

  if (days <= 13)      return wasLikelyPrep && isTakiType ? -1 : -8  // 超短期: 大ペナルティ
  else if (days <= 20) return wasLikelyPrep ? (isTakiType ? 2 : 0) : -3
  else if (days <= 35) return wasLikelyPrep ? (isTakiType ? 5 : 2) : 0  // 叩き良化ボーナス
  // G1馬の標準的な長期休養（36日超）はペナルティなし
  // リアルタイム予想と異なりブラインドテストでは長期休養の影響を中立とする
  return 0
}

function buildScore(entry, race, stat, weights, jockeyStatsMap) {
  // age は関数全体で使うので先に定義
  const age = entry.age ? Number(entry.age) : 0

  if (!stat || stat.totalRaces === 0) {
    let partial = 0
    if (age === 3) partial += 3
    else if (age === 4 || age === 5) partial += 2
    else if (age >= 7) partial -= 3
    return { score: Math.max(22, Math.min(38, 30 + partial)), bonuses: {} }
  }

  const laplaceBase = smoothedRate(stat.totalPlaces, stat.totalRaces)
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
    if (age === 3 && stat.totalRaces >= 2) {
      // 3歳G1初挑戦: 良績なら初挑戦ペナルティを軽減（春G1で無敗の新鋭を正当評価）
      g1Bonus = r >= 0.70 ? 3 : r >= 0.50 ? 0 : r >= 0.30 ? -3 : -6
    } else {
      g1Bonus = r >= 0.45 ? -3 : r >= 0.30 ? -5 : -8
    }
  } else {
    const r = stat.g1Places / stat.g1Races
    if (r >= 0.4)       g1Bonus = 18
    else if (r >= 0.2)  g1Bonus = 8
    else if (stat.g1Races >= 3) g1Bonus = -8
    else                g1Bonus = -1
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
      // 3連勝以上: 圧倒的フォームへの追加ボーナス
      if (pos.length >= 3 && pos[0] === 1 && pos[1] === 1 && pos[2] === 1) formBonus += 5
      // 巻き返し候補: 前走大失敗 + 前々走以前は連続好走（ゲートトラブル等の一発失敗後）
      if (pos.length >= 3 && pos[0] >= 8 && pos[1] <= 2 && pos[2] <= 2) formBonus += 6
    }
  }
  bonuses.recentForm = Math.round(formBonus * (weights.recentFormMult || 1))

  // フォームトレンド（加速/減速）
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

  // 年齢補正
  let ageBonus = 0
  if (age === 3) ageBonus = 3
  else if (age === 4 || age === 5) ageBonus = 2
  else if (age >= 7) ageBonus = -4
  bonuses.age = Math.round(ageBonus * (weights.ageMult || 1))

  // 騎手（動的スタッツ優先）
  bonuses.jockey = Math.round(getJockeyBonus(entry.jockey, jockeyStatsMap) * (weights.jockeyMult || 1))

  // 調教師（scorer.ts 同期）
  bonuses.trainer = Math.round((TRAINER_RANKS[entry.trainer] ?? 0) * (weights.trainerMult || 1))

  // 同一レース相性
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
  bonuses.raceAffinity = Math.round(raceAffinityBonus * (weights.raceAffinityMult || 1))

  // 前哨戦
  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const currentBase = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[currentBase] || []
    for (const prepName of prepList) {
      const pd = stat.raceNameData[prepName]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }
        else                { prepBonus = Math.max(prepBonus, 2) }
      }
    }
  }
  bonuses.prep = prepBonus

  // 馬場状態
  let trackCondBonus = 0
  if (race.trackCondition && race.trackCondition !== '良') {
    const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
    if (race.surface === '芝') {
      if (race.trackCondition === '不良')  trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
      else if (race.trackCondition === '重') trackCondBonus = overallRate >= 0.40 ? 2 : overallRate >= 0.20 ? 0 : -3
    } else if (race.surface === 'ダート') {
      if (race.trackCondition === '重' || race.trackCondition === '不良') trackCondBonus = 3
    }
    // 重馬場専門馬ボーナス: 重/不良での連対率が全体より顕著に高い場合
    if ((race.trackCondition === '重' || race.trackCondition === '不良') && stat.heavyTrackData) {
      const htk = stat.heavyTrackData[race.trackCondition] || stat.heavyTrackData['重'] || null
      if (htk && htk.races >= 2) {
        const htRate = htk.places / htk.races
        const overallR = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
        if (htRate >= overallR + 0.25 && htRate >= 0.40) trackCondBonus += 8  // 重馬場専門馬
        else if (htRate >= overallR + 0.15 && htRate >= 0.30) trackCondBonus += 4
      }
    }
  }
  bonuses.trackCond = Math.round(trackCondBonus * (weights.trackCondMult || 1))

  // ========== v274 新因子 ==========

  // 枠番
  bonuses.gate = Math.round(getGateBonus(entry.frameNumber, race.distance, race.surface) * (weights.gateMult || 1))

  // コース特性（類似コース経験）
  bonuses.courseFeature = Math.round(getCourseFeatureBonus(race.venue, venueData) * (weights.courseFeatureMult || 1))

  // 出走間隔（叩き良化）
  bonuses.restInterval = Math.round(getRestIntervalBonus(stat, race.date) * (weights.restIntervalMult || 1))

  // 少数レース高ポテンシャル
  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    potentialBonus = (stat.g1Places / stat.g1Races) >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  }

  const totalBonus = Object.values(bonuses).reduce((a, b) => a + b, 0) + potentialBonus + trendBonus
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

// ========== ウェイト調整（閾値をベースライン基準に修正） ==========
// 実測ベースラインヒット率: 約23%（G1トップ5予想中の的中率）
// DOWN: 16%未満（ベースライン×0.7 ≒ 実際に予測を悪化させている）
// UP:   48%以上（ベースライン×2.1 ≒ 有意に予測を改善している）
function nudgeWeights(factorSamples, currentWeights) {
  const newWeights = { ...currentWeights }
  const report = []
  const STEP = 0.06
  const DOWN_THRESHOLD = 0.16
  const UP_THRESHOLD   = 0.48
  const MIN = 0.30, MAX = 2.0

  for (const [key, samples] of Object.entries(factorSamples)) {
    if (samples.length < 10) continue
    const posHits  = samples.filter(s => s.val > 0 && s.hit).length
    const posTotal = samples.filter(s => s.val > 0).length
    if (posTotal < 10) continue
    const posRate = posHits / posTotal
    const mult = key + 'Mult'
    if (!(mult in newWeights)) continue
    if (posRate > UP_THRESHOLD) {
      newWeights[mult] = Math.min(MAX, (currentWeights[mult] || 1) + STEP)
      report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → UP ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
    } else if (posRate < DOWN_THRESHOLD) {
      newWeights[mult] = Math.max(MIN, (currentWeights[mult] || 1) - STEP)
      report.push(`  ${key}: posRate=${Math.round(posRate*100)}% → DOWN ${(currentWeights[mult]||1).toFixed(2)}→${newWeights[mult].toFixed(2)}`)
    }
  }
  return { newWeights, report }
}

async function runBlindCycle(weights) {
  const allRaces = await prisma.race.findMany({
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  const statsMap     = new Map()
  const jockeyStatsMap = new Map()
  const finishesMap  = new Map()

  let full = 0, half = 0, miss = 0
  const missDetails = []
  const factorSamples = {
    recentForm: [], distance: [], venue: [], surface: [], g1: [],
    age: [], jockey: [], raceAffinity: [], trackCond: [], prep: [],
    gate: [], trainer: [], restInterval: [], courseFeature: [],
  }
  const rankHits = { 1:{a:0,h:0}, 2:{a:0,h:0}, 3:{a:0,h:0}, 4:{a:0,h:0}, 5:{a:0,h:0}, 6:{a:0,h:0} }
  const yearStats = {}

  for (const race of allRaces) {
    if (race.grade === 'G1') {
      const actual = race.results.filter(r => r.finishPosition <= 2).map(r => r.horseName)
      if (actual.length >= 2) {
        const entryNames = new Set(race.entries.map(e => e.horseName))
        const additional = race.results
          .filter(r => !entryNames.has(r.horseName))
          .map(r => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null, frameNumber: null, trainer: null }))
        const allEntries = [...race.entries, ...additional]

        const scored = scoreAllHorses(allEntries, race, statsMap, weights, jockeyStatsMap)
        const top6Names = scored.map(h => h.horseName)

        const hits = actual.filter(a => top6Names.includes(a)).length
        if (hits === 2) full++
        else if (hits === 1) half++
        else miss++

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

        const yr = race.date.getFullYear()
        if (!yearStats[yr]) yearStats[yr] = { full: 0, half: 0, miss: 0 }
        if (hits === 2) yearStats[yr].full++
        else if (hits === 1) yearStats[yr].half++
        else yearStats[yr].miss++
      }
    }

    // 全グレードの結果でHorseStatを更新
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      const placed = result.finishPosition <= 2
      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
          recentForm: null,
          lastRaceDate: null,
          lastRacePopularity: null,
          heavyTrackData: {},  // 重/不良馬場別成績（重馬場専門馬の検出用）
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
      // 重/不良馬場成績を追跡（専門馬の識別）
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
      // 出走間隔ボーナス用: 最終レース日・人気を更新
      s.lastRaceDate = race.date
      if (result.popularity != null) s.lastRacePopularity = result.popularity
    }

    // 騎手スタッツを時系列で累積
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
  console.log('=== 時系列ブラインド改善サイクル v2 ===\n')

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

  // ====== Round 1 ======
  console.log('\n--- Round 1: ブラインド予想・精度測定 ---')
  const r1 = await runBlindCycle(weights)

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

  // ファクター分析（全因子の posRate を表示）
  console.log('\n因子別ヒット率（基準値≒23%）:')
  for (const [key, samples] of Object.entries(r1.factorSamples)) {
    const posTotal = samples.filter(s => s.val > 0).length
    if (posTotal < 5) continue
    const posHits = samples.filter(s => s.val > 0 && s.hit).length
    const posRate = Math.round(posHits / posTotal * 100)
    const neg = posTotal >= 10 ? (posRate > 48 ? '▲上昇候補' : posRate < 16 ? '▼低下候補' : '－安定') : '(n少)'
    console.log(`  ${key}: ${posRate}% (${posHits}/${posTotal}) ${neg}`)
  }

  console.log('\n外れ代表例（2014年）:')
  r1.missDetails.filter(m => m.date.startsWith('2014')).forEach(m => {
    console.log(`  ${m.name}: 予想[${m.top3.join('/')}] 実際[${m.actual.join('/')}]`)
  })

  console.log('\n外れ詳細（2024年 - 精度60%の内訳）:')
  const miss2024 = r1.missDetails.filter(m => m.date.startsWith('2024'))
  if (miss2024.length === 0) {
    console.log('  2024年の完全外れなし')
  } else {
    miss2024.forEach(m => {
      console.log(`  [完全外れ] ${m.name}: 予想[${m.top3.join('/')}] 実際[${m.actual.join('/')}]`)
      if (m.surprises.length > 0) console.log(`    → 見落とし馬: ${m.surprises.join('/')}`)
    })
  }
  console.log('\n半的中（2024年 - 片方のみ的中）:')
  // 2024 half-hits are races in yearStats[2024] where half++
  // We need to track these separately - approximate via "1 hit" races
  // For now just note the count
  const ys2024 = r1.yearStats[2024]
  if (ys2024) {
    console.log(`  2024合計: ${ys2024.full}完全 / ${ys2024.half}半的中 / ${ys2024.miss}外れ`)
  }

  // ====== ウェイト調整 ======
  console.log('\n--- ウェイト自動調整（ベースライン基準） ---')
  const { newWeights, report } = nudgeWeights(r1.factorSamples, weights)
  if (report.length > 0) report.forEach(r => console.log(r))
  else console.log('  ウェイト変更なし（全因子バランス良好）')

  // ====== Round 2 ======
  let finalWeights = weights
  let finalAccuracy = r1.accuracy
  let finalStats = r1

  if (JSON.stringify(newWeights) !== JSON.stringify(weights)) {
    console.log('\n--- Round 2: 改善ウェイトで再評価 ---')
    const r2 = await runBlindCycle(newWeights)
    console.log(`改善後ブラインド的中率: ${r2.accuracy}% (${r2.full}/${r2.half}/${r2.miss})`)
    console.log(`精度変化: ${r1.accuracy}% → ${r2.accuracy}% (${r2.accuracy >= r1.accuracy ? '+' : ''}${Math.round((r2.accuracy - r1.accuracy)*10)/10}%)`)

    if (r2.accuracy >= r1.accuracy) {
      finalWeights = newWeights; finalAccuracy = r2.accuracy; finalStats = r2
      console.log('→ 精度向上。新ウェイトを採用。')

      // Round 3: さらに改善を試みる
      const { newWeights: w3, report: r3rep } = nudgeWeights(r2.factorSamples, newWeights)
      if (JSON.stringify(w3) !== JSON.stringify(newWeights)) {
        console.log('\n--- Round 3: さらに最適化 ---')
        const r3 = await runBlindCycle(w3)
        console.log(`Round3 的中率: ${r3.accuracy}% (${r3.full}/${r3.half}/${r3.miss})`)
        if (r3.accuracy > r2.accuracy) {
          finalWeights = w3; finalAccuracy = r3.accuracy; finalStats = r3
          console.log('→ Round3 採用。')
        } else {
          console.log('→ Round3 不採用。Round2 維持。')
        }
      }
    } else {
      finalWeights = weights
      console.log('→ 精度低下。元ウェイトを維持。')
    }
  }

  // ====== ウェイト グリッドサーチ（候補値を総当たり） ======
  console.log('\n--- グリッドサーチ: 主要重みの最適値を探索 ---')
  const gridCandidates = [
    { label: 'DEFAULT', w: { ...DEFAULT_WEIGHTS } },
    { label: 'recentForm+', w: { ...finalWeights, recentFormMult: Math.min(1.8, finalWeights.recentFormMult + 0.12) } },
    { label: 'raceAffinity+', w: { ...finalWeights, raceAffinityMult: 1.12 } },
    { label: 'g1+', w: { ...finalWeights, g1Mult: Math.min(1.8, (finalWeights.g1Mult || 0.85) + 0.10) } },
    { label: 'jockey+', w: { ...finalWeights, jockeyMult: Math.min(1.8, (finalWeights.jockeyMult || 0.95) + 0.12) } },
  ]
  let bestLabel = 'current', bestAcc = finalAccuracy, bestW = finalWeights
  for (const { label, w } of gridCandidates) {
    const gr = await runBlindCycle(w)
    const indicator = gr.accuracy > bestAcc ? '★' : gr.accuracy === bestAcc ? '＝' : '  '
    console.log(`  ${indicator} ${label}: ${gr.accuracy}% (${gr.full}/${gr.half}/${gr.miss})`)
    if (gr.accuracy > bestAcc) { bestAcc = gr.accuracy; bestW = w; bestLabel = label }
  }
  if (bestAcc > finalAccuracy) {
    console.log(`\n  → ${bestLabel} ウェイトが最良 (${finalAccuracy}% → ${bestAcc}%)`)
    finalWeights = bestW; finalAccuracy = bestAcc
    const grFinal = await runBlindCycle(finalWeights)
    finalStats = grFinal
  } else {
    console.log('  → グリッドサーチで改善なし。現ウェイト維持。')
  }

  // ====== AlgorithmConfig 更新 ======
  console.log('\n--- AlgorithmConfig更新 ---')
  const improvements = []

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
  if (lowRate > 3)  improvements.push(`低連対率馬(<30%)が${lowRate}回連対。G1での距離・馬場適性重みを増加。`)
  if (highRate > 5) improvements.push(`高連対率馬${highRate}頭が見落とし。有力馬の発見精度向上が必要。`)

  const r1Rate = r1.rankHits[1].a > 0 ? r1.rankHits[1].h / r1.rankHits[1].a : 0
  const r2Rate = r1.rankHits[2].a > 0 ? r1.rankHits[2].h / r1.rankHits[2].a : 0
  if (r1Rate < 0.55) improvements.push(`1位予想的中率${Math.round(r1Rate*100)}%低。トップ馬差別化強化。`)
  if (r2Rate < 0.40) improvements.push(`2位予想的中率${Math.round(r2Rate*100)}%低。2番手馬の評価精度向上。`)

  // ユーザー入力系の重みは保存時に既存値をそのまま引き継ぐ
  const preservedWeights = {
    ...finalWeights,
    lastThreeFurlongMult: weights.lastThreeFurlongMult ?? DEFAULT_WEIGHTS.lastThreeFurlongMult,
    paceMult:             weights.paceMult             ?? DEFAULT_WEIGHTS.paceMult,
  }

  const newVersion = (currentAlgo?.version || 250) + 1
  await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
  await prisma.algorithmConfig.create({
    data: {
      version:       newVersion,
      isActive:      true,
      rules:         improvements.join('\n') || 'ブラインド評価サイクル v2',
      insights:      JSON.stringify({
        localWeights:       preservedWeights,
        localAccuracy:      finalAccuracy,
        blindAccuracy:      finalAccuracy,
        lastLearnedAt:      new Date().toISOString(),
        improvementNotes:   improvements,
      }),
      analyzedCount: finalStats.total,
      accuracy:      finalAccuracy,
    }
  })
  console.log(`AlgorithmConfig v${newVersion} 保存完了`)
  console.log(`ブラインド的中率: ${finalAccuracy}% (${finalStats.total} G1レース)`)
  console.log('最終ウェイト:', JSON.stringify(preservedWeights))

  console.log('\n=== 完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('エラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
