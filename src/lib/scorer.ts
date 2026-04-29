import type { HorseStat } from '@prisma/client'

export interface LocalWeights {
  recentFormMult: number
  distanceMult: number
  venueMult: number
  surfaceMult: number
  g1Mult: number
  ageMult: number
  jockeyMult: number
  raceAffinityMult: number
  trackCondMult: number
  // v274 追加因子
  gateMult: number
  trainerMult: number
  lastThreeFurlongMult: number
  restIntervalMult: number
  courseFeatureMult: number
  paceMult: number
  // v336: 市場オッズ連動補正
  oddsMult: number
  // 血統ボーナス
  bloodlineMult: number
}

// v340 (backfill後ブラインド最適化、2026-04-29): 68.7%精度ベスト
export const DEFAULT_WEIGHTS: LocalWeights = {
  recentFormMult:       0.87,   // 旧0.97 → 0.87（人気を相対的に強化）
  distanceMult:         1.28,
  venueMult:            1.27,   // 旧1.15
  surfaceMult:          1.05,
  g1Mult:               0.90,   // 旧0.80
  ageMult:              0.50,
  jockeyMult:           0.98,   // 旧0.86
  raceAffinityMult:     1.0,
  trackCondMult:        1.0,
  gateMult:             1.0,
  trainerMult:          1.0,
  lastThreeFurlongMult: 1.0,
  restIntervalMult:     1.0,
  courseFeatureMult:    0.88,
  paceMult:             1.0,
  // オッズは強いシグナル。backfill後は1.8で重視
  oddsMult:             1.8,    // 旧1.2 → 1.8
  bloodlineMult:        1.0,
}

interface EntryInput {
  horseNumber: number
  horseName: string
  age?: number | null
  jockey?: string | null
  horseWeight?: number | null
  weightChange?: number | null
  frameNumber?: number | null      // 枠番
  trainer?: string | null           // 調教師
  lastThreeFurlong?: number | null  // 前走上がり3F（秒）
  runningStyle?: string | null      // 脚質: 逃/先/差/追
  oddsPopularity?: number | null    // 単勝人気順位（データ不足馬補正用）
}

interface RaceContext {
  name?: string
  grade: string
  distance: number
  venue: string
  surface: string
  trackCondition?: string
  date?: Date
}

export interface ScoredHorse {
  rank: number
  horseNumber: number | null
  horseName: string
  placeRate: number
  factors: {
    recentForm: string
    distanceSuitability: string
    courseRecord: string
    jockeyStats: string
    reason: string
    _bonuses?: {
      recentForm: number
      distance: number
      venue: number
      surface: number
      g1: number
      age: number
      jockey: number
      raceAffinity: number
      trackCond: number
      prep: number
      gate: number
      trainer: number
      lastThreeFurlong: number
      restInterval: number
      courseFeature: number
      pace: number
      odds: number
      bloodline: number
    }
  }
}

type StatRecord = Record<string, { races: number; places: number }>

// ========== 騎手ランク ==========
const JOCKEY_RANKS: Record<string, number> = {
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
  // 近年活躍騎手追加
  '菅原明良': 7, '横山典弘': 4, '津村明秀': 4,
  '石川裕紀人': 3, '吉田隼人': 4, '藤岡康太': 4,
  '富田暁': 3, '団野大成': 3, '角田大和': 3,
  '岸宏樹': 2, '斎藤新': 3, '武藤雅': 3,
}

// ========== 調教師ランク ==========
const TRAINER_RANKS: Record<string, number> = {
  // S+級 (+10): 年間G1複数制覇
  '国枝栄': 10, '手塚貴久': 10,
  // S級 (+8)
  '矢作芳人': 8, '友道康夫': 8, '木村哲也': 8, '堀宣行': 8, '藤原英昭': 8,
  '中内田充正': 8,
  // A+級 (+5)
  '池江泰寿': 5, '須貝尚介': 5, '高野友和': 5, '斉藤崇史': 5,
  '大久保龍志': 5, '音無秀孝': 5, '安田隆行': 5, '中竹和也': 5, '吉田直弘': 5,
  '田中博康': 5, '石橋守': 5, '西村真幸': 5,
  // A級 (+3)
  '角居勝彦': 3, '石坂正': 3, '平野雄次': 3, '清水久詞': 3,
  '辻野泰之': 3, '昆貢': 3, '加藤士津八': 3, '奥村武': 3, '萩原清': 3,
  '橋口弘次郎': 3, '松田博資': 3,
}

// ========== 競馬場コース特性 ==========
interface CourseFeature {
  slope: 'steep' | 'mild' | 'flat'
  direction: 'right' | 'left'
  straightLength: number  // 最終直線距離(m)
  shape: 'tight' | 'wide'
}
const COURSE_FEATURES: Record<string, CourseFeature> = {
  '東京': { slope: 'mild',  direction: 'left',  straightLength: 525, shape: 'wide'  },
  '中山': { slope: 'steep', direction: 'right', straightLength: 310, shape: 'tight' },
  '阪神': { slope: 'steep', direction: 'right', straightLength: 356, shape: 'wide'  },
  '京都': { slope: 'mild',  direction: 'right', straightLength: 404, shape: 'wide'  },
  '中京': { slope: 'mild',  direction: 'left',  straightLength: 412, shape: 'wide'  },
  '新潟': { slope: 'flat',  direction: 'left',  straightLength: 659, shape: 'wide'  },
  '函館': { slope: 'flat',  direction: 'right', straightLength: 262, shape: 'tight' },
  '札幌': { slope: 'flat',  direction: 'right', straightLength: 266, shape: 'tight' },
  '小倉': { slope: 'flat',  direction: 'right', straightLength: 293, shape: 'tight' },
  '福島': { slope: 'flat',  direction: 'right', straightLength: 292, shape: 'tight' },
}

// ========== 血統辞典 ==========
const SIRE_TRAITS: Record<string, { dist: 'short' | 'mile' | 'middle' | 'long' | 'any'; surf: 'turf' | 'dirt' | 'any'; pts: number }> = {
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
  'スウェプトオーヴァーボード': { dist: 'short', surf: 'any', pts: 2 },
  'クロフネ':           { dist: 'middle', surf: 'dirt', pts: 5 },
  'ゴールドアリュール': { dist: 'middle', surf: 'dirt', pts: 4 },
  'ヘニーヒューズ':     { dist: 'short',  surf: 'dirt', pts: 4 },
  'パイロ':             { dist: 'short',  surf: 'dirt', pts: 3 },
  'カネヒキリ':         { dist: 'middle', surf: 'dirt', pts: 3 },
  'コパノリッキー':     { dist: 'mile',   surf: 'dirt', pts: 3 },
}

function getDistGroup(distance: number): 'short' | 'mile' | 'middle' | 'long' {
  if (distance >= 2400) return 'long'
  if (distance >= 1700) return 'middle'
  if (distance >= 1500) return 'mile'
  return 'short'
}

function getSireTraitBonus(
  sireName: string | null | undefined,
  distGroup: 'short' | 'mile' | 'middle' | 'long',
  surface: string,
  weight: number,
): number {
  if (!sireName) return 0
  for (const [name, trait] of Object.entries(SIRE_TRAITS)) {
    if (sireName.includes(name) || name.includes(sireName)) {
      const distMatch = trait.dist === 'any' || trait.dist === distGroup
      const surfMatch = trait.surf === 'any' || (trait.surf === 'turf' && surface === '芝') || (trait.surf === 'dirt' && surface === 'ダート')
      if (distMatch && surfMatch) return Math.round(trait.pts * weight)
      if (distMatch || surfMatch) return Math.round(trait.pts * weight * 0.3)
      return Math.round(trait.pts * weight * -0.5)
    }
  }
  return 0
}

function getBloodlineBonus(
  stat: { sire?: string | null; dam?: string | null; sireOfSire?: string | null; damOfSire?: string | null; sireOfDam?: string | null; damOfDam?: string | null },
  distance: number,
  surface: string,
): number {
  const distGroup = getDistGroup(distance)
  // 父: 最も直接的な遺伝（w=1.0）
  const b1 = getSireTraitBonus(stat.sire,       distGroup, surface, 1.0)
  // 母: 産駒への影響大（w=0.8）
  const b2 = getSireTraitBonus(stat.dam,         distGroup, surface, 0.8)
  // 父父・父母: 父系祖父母（各w=0.45）
  const b3 = getSireTraitBonus(stat.sireOfSire,  distGroup, surface, 0.45)
  const b4 = getSireTraitBonus(stat.damOfSire,   distGroup, surface, 0.35)
  // 母父・母母: 母系祖父母（各w=0.45/0.3）
  const b5 = getSireTraitBonus(stat.sireOfDam,   distGroup, surface, 0.45)
  const b6 = getSireTraitBonus(stat.damOfDam,    distGroup, surface, 0.3)
  return Math.max(-8, Math.min(12, b1 + b2 + b3 + b4 + b5 + b6))
}

// v340 キャリブレーション: ブラインド実測値に合わせて上限を下げる
// 旧[65,52,38,28,22,18,15] は実連対率(31/25/20/17/14/13/13)から大幅に過大評価。
// 表示値が現実に近づくよう調整。
const RANK_CAPS = [55, 45, 36, 28, 23, 19, 16]

// 前方一致でも騎手ランクを返す（netkeiba の短縮名に対応）
function getJockeyRank(jockey: string | null | undefined): number {
  if (!jockey) return 0
  const exact = JOCKEY_RANKS[jockey]
  if (exact !== undefined) return exact
  // 保存名が短縮形の場合: 「津村」→「津村明秀」など前方一致でマッチ
  for (const [name, rank] of Object.entries(JOCKEY_RANKS)) {
    if (name.startsWith(jockey) && jockey.length >= 2) return rank
    if (jockey.startsWith(name) && name.length >= 2) return rank
  }
  return 0
}

const PREP_RACES: Record<string, string[]> = {
  '日本ダービー':           ['皐月賞', 'NHKマイルカップ', '青葉賞'],
  '菊花賞':               ['神戸新聞杯', 'セントライト記念', '皐月賞'],
  'オークス':              ['桜花賞', 'フローラステークス'],
  '優駿牝馬（オークス）':    ['桜花賞', 'フローラステークス'],
  '天皇賞（春）':           ['阪神大賞典', '日経賞', 'AJCC', '有馬記念'],
  '宝塚記念':              ['大阪杯', '天皇賞（春）'],
  '天皇賞（秋）':           ['毎日王冠', 'オールカマー', '札幌記念'],
  '有馬記念':              ['ジャパンカップ', '天皇賞（秋）', '宝塚記念'],
  'ジャパンカップ':          ['天皇賞（秋）', '宝塚記念'],
  '安田記念':              ['ヴィクトリアマイル', 'NHKマイルカップ'],
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
  '大阪杯':               ['金鯱賞', '中山記念', '京都記念'],
}

// ========== ヘルパー関数 ==========

// Laplace平滑化: 事前確率を18頭中2頭 ≈ 11% に設定。
// 旧: (places+2)/(races+8) → データなし馬に25%を与え過大評価していた。
function smoothedRate(places: number, races: number): number {
  return (places + 1) / (races + 9)
}

// 市場人気補正: 全馬対象。データ量でスケールを調整する。
// G1連対率実績: 1人気≈60%, 2人気≈45%, 3人気≈35%, 4-5人気≈25%, 6-9人気≈15%, 10人気以下≈7%
function getOddsBonus(oddsPopularity: number | null | undefined): number {
  if (oddsPopularity == null) return 0
  if (oddsPopularity === 1)      return 12
  if (oddsPopularity === 2)      return 8
  if (oddsPopularity === 3)      return 5
  if (oddsPopularity <= 5)       return 2
  if (oddsPopularity <= 8)       return -1
  if (oddsPopularity <= 12)      return -4
  return -7
}

function parseRecentForm(form: string): number[] {
  return form.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
}

function getGateBonus(frameNumber: number | null | undefined, distance: number, surface: string): number {
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
    // ダート: 内枠はスタート時に砂を被りやすい
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

function getCourseFeatureBonus(targetVenue: string, venueData: StatRecord): number {
  const target = COURSE_FEATURES[targetVenue]
  if (!target) return 0
  let bonus = 0
  for (const [venue, data] of Object.entries(venueData)) {
    if (venue === targetVenue || data.races === 0) continue
    const feature = COURSE_FEATURES[venue]
    if (!feature) continue
    const slopeSim   = feature.slope === target.slope ? 0.5 : 0
    const dirSim     = feature.direction === target.direction ? 0.3 : 0
    const shapeSim   = feature.shape === target.shape ? 0.2 : 0
    const similarity = slopeSim + dirSim + shapeSim
    if (similarity < 0.3) continue
    const rate = data.places / data.races
    const sf   = Math.min(data.races, 5) / 5
    const raw  = rate >= 0.40 ? 8 * similarity * sf
               : rate >= 0.25 ? 3 * similarity * sf
               : rate < 0.10  ? -4 * similarity * sf
               : 0
    bonus = Math.max(bonus, raw)
  }
  return Math.min(Math.round(bonus), 8)
}

function getLastThreeFurlongBonus(ltf: number | null | undefined, surface: string): number {
  if (ltf == null) return 0
  const base = surface === 'ダート' ? 36.5 : 33.5
  const diff = ltf - base
  if (diff <= -1.5) return 12
  if (diff <= -0.8) return 8
  if (diff <= -0.3) return 4
  if (diff <= 0.3)  return 0
  if (diff <= 0.8)  return -3
  return -6
}

function getRestIntervalBonus(
  stat: HorseStat & { lastRacePopularity?: number | null },
  raceDate: Date | undefined,
): number {
  if (!stat.lastRaceDate || !raceDate) return 0
  const days = Math.floor((new Date(raceDate).getTime() - new Date(stat.lastRaceDate).getTime()) / 86400000)
  if (days <= 0) return 0

  // 前走着順を recentForm から取得
  let lastRacePosition: number | null = null
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
    lastRacePosition = pos[0] ?? null
  }

  // 前走: 人気(1-3位)だったが着外(5着以下) = 叩き（ローテ踏み台）候補
  const wasLikelyPrep = (stat.lastRacePopularity != null && stat.lastRacePopularity <= 3) &&
                         (lastRacePosition != null && lastRacePosition >= 5)

  // 叩き良化型: recentFormで「着順改善」パターンが2回以上（後ろから前に来るパターン）
  let takiCount = 0
  if (stat.recentForm) {
    const pos = stat.recentForm.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
    for (let i = 0; i < Math.min(pos.length - 1, 4); i++) {
      if (pos[i] < pos[i + 1]) takiCount++
    }
  }
  const isTakiType = takiCount >= 2

  if (days <= 13) {
    return wasLikelyPrep && isTakiType ? -1 : -8
  } else if (days <= 20) {
    if (wasLikelyPrep) return isTakiType ? 3 : 0
    return -3
  } else if (days <= 35) {
    if (wasLikelyPrep) return isTakiType ? 5 : 2
    return 0
  } else if (days <= 56) {
    return -1
  } else if (days <= 84) {
    return -1  // G1馬の中期休養は中立寄りに
  } else if (days <= 150) {
    return -3  // 長期休養もペナルティ軽減
  }
  return -5  // 超長期もG1馬なら過剰ペナルティを避ける
}

function getPaceBonus(runningStyle: string | null | undefined, paceType: 'high' | 'medium' | 'slow'): number {
  if (!runningStyle || paceType === 'medium') return 0
  if (paceType === 'high') {
    if (runningStyle === '逃') return -10
    if (runningStyle === '先') return -5
    if (runningStyle === '差') return 5
    if (runningStyle === '追') return 8
  } else {
    if (runningStyle === '逃') return 8
    if (runningStyle === '先') return 6
    if (runningStyle === '差') return -3
    if (runningStyle === '追') return -6
  }
  return 0
}

// ========== メインスコアリング ==========

export function localScoreHorses(
  entries: EntryInput[],
  race: RaceContext,
  stats: HorseStat[],
  weights: LocalWeights = DEFAULT_WEIGHTS
): ScoredHorse[] {
  const statMap = new Map(stats.map((s) => [s.horseName, s]))

  // 展開予測: 脚質分布からペース推定
  let frontCount = 0, styleTotal = 0
  for (const e of entries) {
    if (!e.runningStyle) continue
    styleTotal++
    if (e.runningStyle === '逃' || e.runningStyle === '先') frontCount++
  }
  let paceType: 'high' | 'medium' | 'slow' = 'medium'
  if (styleTotal >= 4) {
    const ratio = frontCount / styleTotal
    if (ratio >= 0.5) paceType = 'high'
    else if (ratio <= 0.2) paceType = 'slow'
  }

  const scored = entries.map((entry) => {
    const stat = statMap.get(entry.horseName) ?? null
    return buildScore(entry, race, stat, weights, paceType)
  })

  scored.sort((a, b) => b.placeRate - a.placeRate)

  const top7 = scored.slice(0, 7)

  for (let i = 0; i < top7.length; i++) {
    const cap = RANK_CAPS[i] ?? 15
    top7[i].placeRate = Math.min(top7[i].placeRate, cap)
  }

  if (top7.length >= 2 && top7[0].placeRate - top7[1].placeRate < 5) {
    top7[1].placeRate = Math.max(top7[1].placeRate - 7, (RANK_CAPS[1] ?? 52) - 12)
  }
  if (top7.length >= 3 && top7[1].placeRate - top7[2].placeRate < 5) {
    top7[2].placeRate = Math.max(top7[2].placeRate - 12, (RANK_CAPS[2] ?? 38) - 14)
  }
  if (top7.length >= 2 && top7[0].placeRate - top7[1].placeRate < 1) {
    top7[0].placeRate = Math.max(top7[0].placeRate - 5, top7[1].placeRate + 2)
  }

  return top7.map((s, i) => ({
    ...s,
    rank: i + 1,
    placeRate: Math.round(s.placeRate * 10) / 10,
  }))
}

function buildScore(
  entry: EntryInput,
  race: RaceContext,
  stat: (HorseStat & { lastRacePopularity?: number | null }) | null,
  weights: LocalWeights,
  paceType: 'high' | 'medium' | 'slow' = 'medium'
): ScoredHorse {
  if (!stat || stat.totalRaces === 0) {
    // v340: データなし馬でも市場人気・騎手・厩舎から大胆に評価する
    // 旧: 上限50%でデータ豊富馬の60%以上に届かず、人気上位の新興勢力が常に圏外に落ちていた
    let partialBonus = 0
    let baseScore = 25  // 旧22→25
    const notes: string[] = []
    if (entry.age != null) {
      if (entry.age === 3)                         { partialBonus += 3; notes.push('3歳') }
      else if (entry.age === 4 || entry.age === 5) { partialBonus += 2; notes.push(`${entry.age}歳`) }
      else if (entry.age >= 7)                     { partialBonus -= 3; notes.push(`${entry.age}歳晩年`) }
    }
    if (entry.weightChange != null) {
      if (Math.abs(entry.weightChange) <= 3)  partialBonus += 2
      else if (Math.abs(entry.weightChange) > 10) partialBonus -= 5
    }
    // 騎手ランク（データなし時でも有力騎手を評価）
    let jockeyNote = entry.jockey ?? '未定'
    let topJockey = false
    if (entry.jockey) {
      const jRank = getJockeyRank(entry.jockey)
      partialBonus += Math.round(jRank * 0.9)  // 旧0.7→0.9
      if (jRank >= 14)      { jockeyNote = `${entry.jockey}(最上位騎手)`; notes.push(jockeyNote); topJockey = true }
      else if (jRank >= 10) { jockeyNote = `${entry.jockey}(S級騎手)`;   notes.push(jockeyNote); topJockey = true }
      else if (jRank >= 7)  { jockeyNote = `${entry.jockey}(A+級騎手)`;  notes.push(jockeyNote) }
    }
    // 調教師ランク（データなし時でも有力厩舎を評価）
    let topTrainer = false
    if (entry.trainer) {
      const tRank = TRAINER_RANKS[entry.trainer] ?? 0
      partialBonus += Math.round(tRank * 0.6)  // 旧0.4→0.6
      if (tRank >= 8) { notes.push(`${entry.trainer}厩舎(S級)`); topTrainer = true }
      else if (tRank >= 5) notes.push(`${entry.trainer}厩舎`)
    }
    // 枠番ボーナス（軽く反映）
    const gBonusRaw = getGateBonus(entry.frameNumber, race.distance, race.surface)
    partialBonus += Math.round(gBonusRaw * 0.4)
    // 前走上がり3F（データなし時も反映）
    const ltfBonusRaw = getLastThreeFurlongBonus(entry.lastThreeFurlong, race.surface)
    partialBonus += Math.round(ltfBonusRaw * 0.5)
    // 人気補正（v340: データなし馬は市場人気を主信号として大胆に使う）
    if (entry.oddsPopularity != null) {
      const oddsRaw = getOddsBonus(entry.oddsPopularity)
      partialBonus += Math.round(oddsRaw * 1.8)  // 旧1.4→1.8
      if (entry.oddsPopularity <= 3) {
        notes.push(`${entry.oddsPopularity}番人気`)
        // 人気1-3位なら基底を底上げ（市場が高評価＝戦績不明でも実力者の証）
        baseScore += entry.oddsPopularity === 1 ? 14 : entry.oddsPopularity === 2 ? 10 : 7
      } else if (entry.oddsPopularity <= 5) {
        baseScore += 3
      }
    }
    // トップ騎手×トップ厩舎の組み合わせ：実力馬の典型パターン
    if (topJockey && topTrainer) partialBonus += 4
    return {
      rank: 0,
      horseNumber: entry.horseNumber,
      horseName: entry.horseName,
      // 旧: max(18, min(50, 22 + partialBonus)) → 上限を65に拡大しデータ豊富馬と同等に競える
      placeRate: Math.max(18, Math.min(65, baseScore + partialBonus)),
      factors: {
        recentForm: 'データなし',
        distanceSuitability: '距離実績未収集',
        courseRecord: 'コース実績未収集',
        jockeyStats: jockeyNote,
        reason: `DBに成績データなし${notes.length ? `（${notes.join('/')}）` : ''}。市場人気・騎手・厩舎から推定。`,
      },
    }
  }

  const distData = stat.distanceData as StatRecord
  const venueData = stat.venueData as StatRecord
  const surfData = stat.surfaceData as StatRecord

  const baseSmoothed = smoothedRate(stat.totalPlaces, stat.totalRaces)

  let effectiveBase = baseSmoothed * 100
  if (race.grade === 'G1' && stat.g1Races >= 1) {
    const g1Smoothed = smoothedRate(stat.g1Places, stat.g1Races)
    const g1Weight = Math.min(stat.g1Races, 10) / 10 * 0.6
    effectiveBase = baseSmoothed * (1 - g1Weight) * 100 + g1Smoothed * g1Weight * 100
  }

  // v340: 少データ馬に人気ベースのpriorをブレンドする
  // 理由: stat.totalRaces=1で0/1の馬は smoothedRate=10% と過小評価されるが、
  // 市場が2番人気と評価していれば実力40-50%レベル。少データほどpriorを重視。
  if (stat.totalRaces < 4 && entry.oddsPopularity != null) {
    const pop = entry.oddsPopularity
    const popPrior = pop === 1 ? 55
                  : pop === 2 ? 45
                  : pop === 3 ? 35
                  : pop <= 5 ? 28
                  : pop <= 8 ? 20
                  : 15
    const priorWeight = (4 - stat.totalRaces) / 4 * 0.7  // 0戦時0.7、1戦0.525、2戦0.35、3戦0.175
    effectiveBase = effectiveBase * (1 - priorWeight) + popPrior * priorWeight
  }

  // --- 近走フォーム ---
  let recentFormBonus = 0
  let recentFormText = `通算${stat.totalRaces}戦${stat.totalPlaces}連対`

  if (stat.recentForm) {
    const positions = parseRecentForm(stat.recentForm)
    if (positions.length > 0) {
      recentFormText = `直近: ${stat.recentForm}`
      const ws = [0.40, 0.25, 0.18, 0.12, 0.05]
      let wSum = 0, wTotal = 0
      for (let i = 0; i < Math.min(positions.length, 5); i++) {
        const w = ws[i] ?? 0.05
        wSum += positions[i] * w
        wTotal += w
      }
      const avgPos = wSum / wTotal
      if (avgPos <= 1.4)      recentFormBonus = 24
      else if (avgPos <= 1.8) recentFormBonus = 20
      else if (avgPos <= 2.2) recentFormBonus = 15
      else if (avgPos <= 3.0) recentFormBonus = 8
      else if (avgPos <= 4.5) recentFormBonus = 1
      else if (avgPos <= 5.5) recentFormBonus = 0
      else if (avgPos > 7.0)  recentFormBonus = -10
      else                    recentFormBonus = -4

      if (positions.length >= 2 && positions[0] <= 2 && positions[1] <= 2) recentFormBonus += 5
      if (positions[0] === 1) recentFormBonus += 3
      // 3連勝以上: 圧倒的フォームへの追加ボーナス
      if (positions.length >= 3 && positions[0] === 1 && positions[1] === 1 && positions[2] === 1) recentFormBonus += 5
      // 巻き返し候補: 前走大失敗 + 前々走以前は連続好走（ゲートトラブル等の一発失敗後）
      if (positions.length >= 3 && positions[0] >= 8 && positions[1] <= 2 && positions[2] <= 2) recentFormBonus += 6
      // 叩き良化候補: 前走4-5着も2-3走前に連続好走（仕上げ不足からの変わり身）
      if (positions.length >= 3 && positions[0] >= 4 && positions[0] <= 5 &&
          positions[1] <= 2 && positions[2] <= 3) recentFormBonus += 4
    }
  }

  // --- 距離適性 ---
  let distanceBonus = 0
  const dk = String(race.distance)
  const dStat = distData[dk]
  let distanceSuitability = `${race.distance}mの実績なし`

  if (dStat && dStat.races > 0) {
    const sf = Math.min(dStat.races, 5) / 5
    const r = dStat.places / dStat.races
    if (r >= 0.5) {
      distanceBonus = Math.round(15 * sf)
      distanceSuitability = `◎ ${race.distance}mで${dStat.races}戦${dStat.places}連対（得意距離）`
    } else if (r >= 0.3) {
      distanceBonus = Math.round(7 * sf)
      distanceSuitability = `○ ${race.distance}mで${dStat.races}戦${dStat.places}連対`
    } else {
      distanceBonus = -Math.round(5 * sf)
      distanceSuitability = `△ ${race.distance}mの成績が低調`
    }
  } else {
    const nearby = [
      { d: race.distance - 200, factor: 0.5 },
      { d: race.distance + 200, factor: 0.5 },
      { d: race.distance - 400, factor: 0.3 },
      { d: race.distance + 400, factor: 0.3 },
    ]
    let bestNearby = 0
    for (const { d, factor } of nearby) {
      const nd = distData[String(d)]
      if (nd && nd.races >= 2) {
        const r = nd.places / nd.races
        const val = r >= 0.5 ? 15 * factor : r >= 0.3 ? 7 * factor : -5 * factor
        if (val > bestNearby) bestNearby = val
      }
    }
    if (bestNearby > 0) {
      distanceBonus = Math.round(bestNearby)
      distanceSuitability = `${race.distance}m近隣距離での実績あり（参考）`
    }
  }

  // --- コース実績 ---
  let venueBonus = 0
  const vStat = venueData[race.venue]
  let courseRecord = `${race.venue}実績なし`
  if (vStat && vStat.races > 0) {
    const sf = Math.min(vStat.races, 5) / 5
    const r = vStat.places / vStat.races
    if (r >= 0.4) {
      venueBonus = Math.round(10 * sf)
      courseRecord = `◎ ${race.venue}で${vStat.races}戦${vStat.places}連対（得意コース）`
    } else if (r >= 0.2) {
      venueBonus = Math.round(3 * sf)
      courseRecord = `${race.venue}で${vStat.races}戦${vStat.places}連対`
    } else if (vStat.races >= 3) {
      venueBonus = -Math.round(4 * sf)
      courseRecord = `△ ${race.venue}での成績が低調`
    } else {
      courseRecord = `${race.venue}で${vStat.races}戦${vStat.places}連対`
    }
  }

  // --- 馬場 ---
  let surfaceBonus = 0
  const sStat = surfData[race.surface]
  if (sStat && sStat.races > 0) {
    const sf = Math.min(sStat.races, 8) / 8
    const r = sStat.places / sStat.races
    if (r >= 0.5)      surfaceBonus = Math.round(8 * sf)
    else if (r >= 0.3) surfaceBonus = Math.round(3 * sf)
    else if (r < 0.2)  surfaceBonus = -Math.round(8 * sf)
  }

  // --- G1実績 ---
  // G1初挑戦時に前哨戦連対実績があるか先確認（ペナルティ緩和用）
  let hasPrepWin = false
  if (race.grade === 'G1' && stat.g1Races === 0 && race.name && stat.raceNameData) {
    const currentRaceBase0 = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList0 = PREP_RACES[currentRaceBase0] ?? []
    for (const prepName0 of prepList0) {
      const pd0 = (stat.raceNameData as StatRecord)[prepName0]
      if (pd0 && pd0.places >= 1) { hasPrepWin = true; break }
    }
  }

  let g1Bonus = 0
  let g1Note = ''
  if (race.grade === 'G1') {
    if (stat.g1Races === 0) {
      const overallRate = stat.totalRaces > 0 ? stat.totalPlaces / stat.totalRaces : 0
      const is3yoDebut = entry.age === 3 && stat.totalRaces >= 2
      if (is3yoDebut) {
        // 3歳G1初挑戦: 良績なら初挑戦ペナルティを軽減（無敗の新鋭を正当評価）
        g1Bonus = overallRate >= 0.70 ? 3 : overallRate >= 0.50 ? 0 : overallRate >= 0.30 ? -3 : -6
        if (hasPrepWin && g1Bonus < 0) g1Bonus = Math.min(g1Bonus + 4, 0)  // 前哨戦連対でペナルティ緩和
        g1Note = `3歳G1初挑戦(連対率${Math.round(overallRate*100)}%)`
      } else {
        g1Bonus = overallRate >= 0.45 ? -3 : overallRate >= 0.30 ? -5 : -8
        if (hasPrepWin && g1Bonus < 0) g1Bonus = Math.min(g1Bonus + 5, 0)  // 前哨戦連対でペナルティ緩和
        g1Note = overallRate >= 0.30 ? `G1初挑戦(連対率${Math.round(overallRate*100)}%)` : 'G1初挑戦'
      }
    } else {
      const g1Rate = stat.g1Places / stat.g1Races
      if (g1Rate >= 0.4) {
        g1Bonus = 18
        g1Note = `G1で${stat.g1Races}戦${stat.g1Places}連対(高実績)`
      } else if (g1Rate >= 0.2) {
        g1Bonus = 8
        g1Note = `G1で${stat.g1Races}戦${stat.g1Places}連対`
      } else if (stat.g1Races >= 3) {
        g1Bonus = -8
        g1Note = `G1で${stat.g1Races}戦連対なし(苦手)`
      } else {
        g1Bonus = -1
        g1Note = `G1で${stat.g1Races}戦連対なし`
      }
      let sameDistCredit = 0
      for (const [dk2, dv2] of Object.entries(distData)) {
        const d2 = parseInt(dk2, 10)
        if (isNaN(d2) || d2 === race.distance) continue
        if (Math.abs(d2 - race.distance) <= 100 && dv2.places > 0) {
          sameDistCredit = Math.max(sameDistCredit, 6)
        }
      }
      if (vStat && vStat.places > 0 && stat.g1Places > 0) {
        sameDistCredit = Math.max(sameDistCredit, 5)
      }
      const credit = Math.min(sameDistCredit, 8)
      g1Bonus += credit
      if (credit > 0) g1Note += '+近距離G1'
    }
  }

  // --- 年齢 ---
  let ageBonus = 0
  let ageNote = ''
  if (entry.age != null) {
    if (entry.age === 3)                         { ageBonus = 3;  ageNote = '3歳(ポテンシャル)' }
    else if (entry.age === 4 || entry.age === 5) { ageBonus = 2;  ageNote = `${entry.age}歳(充実期)` }
    else if (entry.age >= 7)                     { ageBonus = -4; ageNote = `${entry.age}歳(晩年期)` }
  }

  // --- 馬体重 ---
  let weightNote = ''
  let weightBonus = 0
  if (entry.weightChange != null) {
    const wc = entry.weightChange
    const sign = wc > 0 ? '+' : ''
    if (Math.abs(wc) <= 3)       { weightBonus = 3;  weightNote = `体重安定(${sign}${wc}kg)` }
    else if (Math.abs(wc) > 10)  { weightBonus = -8; weightNote = `体重大幅変動(${sign}${wc}kg)` }
    else if (Math.abs(wc) > 6)   { weightBonus = -4; weightNote = `体重変動(${sign}${wc}kg)` }
    else                          { weightBonus = -2; weightNote = `体重小変動(${sign}${wc}kg)` }
  }

  // --- 騎手 ---
  let jockeyBonus = 0
  let jockeyNote = ''
  if (entry.jockey) {
    const jRank = getJockeyRank(entry.jockey)
    jockeyBonus = jRank
    if (jRank >= 14) jockeyNote = `${entry.jockey}(最上位騎手)`
    else if (jRank >= 10) jockeyNote = `${entry.jockey}(S級騎手)`
    else if (jRank >= 7) jockeyNote = `${entry.jockey}(A+級騎手)`
    else if (jRank >= 4) jockeyNote = `${entry.jockey}(A級騎手)`
    else jockeyNote = entry.jockey
  }

  // --- ポテンシャル補正 ---
  let potentialBonus = 0
  if (stat.totalRaces <= 6 && stat.g1Places > 0) {
    const g1Rate = stat.g1Places / stat.g1Races
    potentialBonus = g1Rate >= 0.5 ? 10 : 7
  } else if (stat.totalRaces <= 4 && stat.totalPlaces >= 2) {
    potentialBonus = 5
  } else if (stat.totalRaces <= 3 && stat.totalPlaces >= 1 && stat.g1Races === 0) {
    potentialBonus = 3  // 少数戦新鋭: 連対実績あり伏兵
  }

  // --- フォームトレンド ---
  // v340: 上昇トレンドの検出を強化。直近1戦への重み付けを大きく。
  let trendBonus = 0
  if (stat.recentForm) {
    const tPos = stat.recentForm.split('-').map(Number).filter((n) => !isNaN(n) && n > 0)
    if (tPos.length >= 4) {
      const recentAvg = (tPos[0] + tPos[1]) / 2
      const olderAvg  = (tPos[2] + tPos[3]) / 2
      if (recentAvg < olderAvg - 2.5) trendBonus = 9
      else if (recentAvg < olderAvg - 1.5) trendBonus = 6
      else if (recentAvg < olderAvg - 0.5) trendBonus = 3
      else if (recentAvg > olderAvg + 2) trendBonus = -5
    }
    // 直近2戦が連対 + 過去2戦は2着外 → 開花パターン
    if (tPos.length >= 4 && tPos[0] <= 2 && tPos[1] <= 2 && tPos[2] >= 4 && tPos[3] >= 4) {
      trendBonus = Math.max(trendBonus, 7)
    }
  }

  // --- 同レース相性 ---
  let raceAffinityBonus = 0
  if (race.name && stat.raceNameData) {
    const raceKey = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const rnData = (stat.raceNameData as StatRecord)[raceKey]
    if (rnData && rnData.races > 0) {
      if (rnData.places >= 2)      raceAffinityBonus = 18
      else if (rnData.places >= 1) raceAffinityBonus = 6
      else if (rnData.races >= 3)  raceAffinityBonus = -4
    }
  }

  // --- 前哨戦 ---
  let prepBonus = 0
  if (race.name && stat.raceNameData) {
    const currentRaceBase = race.name.replace(/\s*\d{4}年?\s*$/, '').trim()
    const prepList = PREP_RACES[currentRaceBase] ?? []
    for (const prepName of prepList) {
      const pd = (stat.raceNameData as StatRecord)[prepName]
      if (pd && pd.races >= 1) {
        if (pd.places >= 1) { prepBonus = Math.max(prepBonus, 6); break }
        else                { prepBonus = Math.max(prepBonus, 2) }
      }
    }
  }

  // --- 馬場状態 ---
  let trackCondBonus = 0
  if (race.trackCondition && race.trackCondition !== '良') {
    if (race.surface === '芝') {
      if (race.trackCondition === '不良') {
        const overallRate = stat.totalPlaces / stat.totalRaces
        trackCondBonus = overallRate >= 0.40 ? 3 : overallRate >= 0.25 ? 0 : -5
      } else if (race.trackCondition === '重') {
        const overallRate = stat.totalPlaces / stat.totalRaces
        trackCondBonus = overallRate >= 0.40 ? 2 : overallRate >= 0.20 ? 0 : -3
      }
    } else if (race.surface === 'ダート') {
      if (race.trackCondition === '重' || race.trackCondition === '不良') trackCondBonus = 3
      else if (race.trackCondition === '稍重') trackCondBonus = 1
    }
  }

  // ========== v274 新因子 ==========

  // ⑨ 枠番
  const gateBonus = getGateBonus(entry.frameNumber, race.distance, race.surface)

  // ⑦ 調教師
  let trainerBonus = 0
  let trainerNote = ''
  if (entry.trainer) {
    trainerBonus = TRAINER_RANKS[entry.trainer] ?? 0
    if (trainerBonus >= 8) trainerNote = `${entry.trainer}厩舎(S級調教師)`
    else if (trainerBonus >= 5) trainerNote = `${entry.trainer}厩舎(A+級調教師)`
    else if (trainerBonus >= 3) trainerNote = `${entry.trainer}厩舎(A級調教師)`
  }

  // ⑧ 上がり3F（前走末脚）
  const ltfBonus = getLastThreeFurlongBonus(entry.lastThreeFurlong, race.surface)

  // ③ 競馬場コース特性（類似コース経験から補正）
  const courseFeatureBonus = getCourseFeatureBonus(race.venue, venueData)

  // ⑪ 出走間隔（叩き良化パターン考慮）
  const restIntervalBonus = getRestIntervalBonus(stat, race.date)

  // ⑤ 展開（脚質×予想ペース）
  const paceBonus = getPaceBonus(entry.runningStyle, paceType)

  // ========== 重み乗算 ==========
  const wRecentForm    = Math.round(recentFormBonus      * weights.recentFormMult)
  const wDistance      = Math.round(distanceBonus        * weights.distanceMult)
  const wVenue         = Math.round(venueBonus           * weights.venueMult)
  const wSurface       = Math.round(surfaceBonus         * weights.surfaceMult)
  const wG1            = Math.round(g1Bonus              * weights.g1Mult)
  const wAge           = Math.round(ageBonus             * weights.ageMult)
  const wJockey        = Math.round(jockeyBonus          * weights.jockeyMult)
  const wRaceAffinity  = Math.round(raceAffinityBonus    * weights.raceAffinityMult)
  const wTrackCond     = Math.round(trackCondBonus       * weights.trackCondMult)
  const wGate          = Math.round(gateBonus            * weights.gateMult)
  const wTrainer       = Math.round(trainerBonus         * weights.trainerMult)
  const wLtf           = Math.round(ltfBonus             * weights.lastThreeFurlongMult)
  const wRest          = Math.round(restIntervalBonus    * weights.restIntervalMult)
  const wCourseFeature = Math.round(courseFeatureBonus   * weights.courseFeatureMult)
  const wPace          = Math.round(paceBonus            * weights.paceMult)

  // 人気補正（全馬対象）: データが豊富な馬ほどオッズへの依存を下げる
  const oddsRaw = getOddsBonus(entry.oddsPopularity)
  const oddsDataScale = stat.totalRaces >= 10 ? 0.35 : stat.totalRaces >= 4 ? 0.65 : 1.0
  const wOdds = Math.round(oddsRaw * oddsDataScale * weights.oddsMult)

  // 血統ボーナス（父・母・父父・父母・母父・母母の2世代全祖先分析）
  const bloodlineRaw = getBloodlineBonus(stat as { sire?: string | null; dam?: string | null; sireOfSire?: string | null; damOfSire?: string | null; sireOfDam?: string | null; damOfDam?: string | null }, race.distance, race.surface)
  const wBloodline = Math.round(bloodlineRaw * weights.bloodlineMult)

  const totalBonus = wRecentForm + wDistance + wVenue + wSurface + wG1 + wAge
    + wJockey + wRaceAffinity + wTrackCond + prepBonus + weightBonus
    + potentialBonus + trendBonus
    + wGate + wTrainer + wLtf + wRest + wCourseFeature + wPace + wOdds + wBloodline

  // v340 キャリブレーション: 旧60→50 で過大評価を抑制
  // 1位予測平均62.8% vs 実連対率31.5% の +31pt 乖離を是正
  const cappedBase = Math.min(effectiveBase, 50)
  // 旧24→22 で底上げを緩和（過剰promo を抑制）
  const minFloor = (race.grade === 'G1' && stat.g1Races >= 2) ? 22 : 18
  const finalRate = Math.max(minFloor, cappedBase + totalBonus)

  const reason = [
    `ベース連対率${(baseSmoothed * 100).toFixed(0)}%(${stat.totalRaces}戦)`,
    g1Note, ageNote, jockeyNote, trainerNote, weightNote,
    entry.lastThreeFurlong ? `上がり3F:${entry.lastThreeFurlong}秒` : '',
    entry.runningStyle && paceType !== 'medium' ? `${entry.runningStyle}/${paceType === 'high' ? 'ハイペース' : 'スロー'}展開` : '',
    entry.oddsPopularity != null ? `${entry.oddsPopularity}番人気` : '',
  ].filter(Boolean).join('、')

  return {
    rank: 0,
    horseNumber: entry.horseNumber,
    horseName: entry.horseName,
    placeRate: Math.round(finalRate * 10) / 10,
    factors: {
      recentForm: recentFormText,
      distanceSuitability,
      courseRecord,
      jockeyStats: jockeyNote || entry.jockey || '未定',
      reason,
      _bonuses: {
        recentForm: wRecentForm,
        distance:   wDistance,
        venue:      wVenue,
        surface:    wSurface,
        g1:         wG1,
        age:        wAge,
        jockey:     wJockey,
        raceAffinity: wRaceAffinity,
        trackCond:  wTrackCond,
        prep:       prepBonus,
        gate:         wGate,
        trainer:      wTrainer,
        lastThreeFurlong: wLtf,
        restInterval: wRest,
        courseFeature: wCourseFeature,
        pace:         wPace,
        odds:         wOdds,
        bloodline:    wBloodline,
      },
    },
  }
}

// predict/route.ts のためのエントリー補完ユーティリティ
export function mergeEntriesWithResults(
  entries: { horseNumber: number; horseName: string; age?: number | null; jockey?: string | null }[],
  results: { horseNumber: number; horseName: string }[]
) {
  const entryNames = new Set(entries.map((e) => e.horseName))
  const additional = results
    .filter((r) => !entryNames.has(r.horseName))
    .map((r) => ({ horseNumber: r.horseNumber, horseName: r.horseName, age: null, jockey: null }))
  return [...entries, ...additional]
}
