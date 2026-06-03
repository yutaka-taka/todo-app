/**
 * LightGBM 特徴量ビルダー
 * EntryInput + HorseStat → MLFeatureVector に変換
 */
import fs from 'fs'
import path from 'path'
import type { HorseStat } from '@prisma/client'
import type { MLFeatureVector } from './mlInference'

// 血統適性テーブル（scripts/build_pedigree_aptitude.js が出力）。無ければ null。
type AptTable = {
  sireDist?: Record<string, Record<string, number>>
  sireSurf?: Record<string, Record<string, number>>
  bmsDist?: Record<string, Record<string, number>>
}
let _apt: AptTable | null | undefined
function getAptitude(): AptTable | null {
  if (_apt !== undefined) return _apt
  try {
    const p = path.join(process.cwd(), 'ml', 'pedigree_aptitude.json')
    _apt = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as AptTable) : null
  } catch { _apt = null }
  return _apt
}

const JOCKEY_RANKS: Record<string, number> = {
  'C.ルメール': 14, 'ルメール': 14,
  '武豊': 10, '川田将雅': 10, '横山武史': 10,
  '坂井瑠星': 7, '岩田望来': 7, '松山弘平': 7,
  '戸崎圭太': 7, '池添謙一': 7, '北村友一': 7,
  'M.デムーロ': 7, 'デムーロ': 7,
  '福永祐一': 7, '藤岡佑介': 5, '浜中俊': 5,
}

const TRAINER_RANKS: Record<string, number> = {
  '矢作芳人': 10, '国枝栄': 9, '池江泰寿': 9, '藤沢和雄': 8,
  '友道康夫': 8, '須貝尚介': 7, '音無秀孝': 7, '堀宣行': 8,
  '手塚貴久': 7, '中内田充正': 8, '高野友和': 7,
  '安田翔伍': 6, '奥村武': 5,
}

const VENUE_WIN_RATE: Record<string, number> = {
  '東京': 0.119, '中山': 0.108, '阪神': 0.115, '京都': 0.114,
  '中京': 0.111, '新潟': 0.108, '札幌': 0.110, '函館': 0.109,
  '小倉': 0.110, '福島': 0.109,
}

const GRADE_RANK: Record<string, number> = { G1: 4, G2: 3, G3: 2, '通常': 1 }

function distanceBin(d: number): number {
  if (d <= 1400) return 0
  if (d <= 1700) return 1
  if (d <= 2100) return 2
  return 3
}

function getJsonRate(jsonVal: unknown, key: string): number | null {
  try {
    const d = (typeof jsonVal === 'string' ? JSON.parse(jsonVal) : jsonVal) as Record<string, { races: number; places: number }> | null
    const v = d?.[key]
    if (v && v.races > 0) return v.places / v.races
  } catch { /* ignore */ }
  return null
}

function parseForm(s: string | null | undefined, n = 5): number[] {
  const parts = (s || '').split('-').slice(0, n)
  const result = parts.map(p => parseInt(p) || 0)
  while (result.length < n) result.push(0)
  return result
}

// 過去走が無い場合のフォールバック（build_dataset.py / reanalyze.js と一致）
const DEF_SPEED = 0.0, DEF_POSRATIO = 0.5, DEF_FRONT = 0.0, DEF_R3F = 35.0, DEF_POP = 9

export function buildMLFeatures(
  entry: {
    horseName: string
    jockey?: string | null
    trainer?: string | null
    age?: number | null
  },
  race: {
    grade: string
    surface: string
    distance: number
    venue: string
    date?: Date
  },
  stat: HorseStat | null,
): MLFeatureVector {
  const now = race.date ?? new Date()
  const month = now.getMonth() + 1
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000)

  const totalRaces  = stat?.totalRaces ?? 0
  const totalPlaces = stat?.totalPlaces ?? 0
  const placeRate   = totalRaces > 0 ? totalPlaces / totalRaces : 0.111

  const form = parseForm(stat?.recentForm, 5)
  const formAvg = form.reduce((a, b) => a + b, 0) / form.length
  const formRecent3Avg = (form[0] + form[1] + form[2]) / 3

  const lastRaceDate = stat?.lastRaceDate ? new Date(stat.lastRaceDate) : null
  const daysSinceLast = lastRaceDate ? Math.min(Math.floor((now.getTime() - lastRaceDate.getTime()) / 86400000), 365) : 180

  // 血統適性（父産駒・母父産駒の距離帯/馬場連対率）。未取得・少数は自馬の place_rate を既定値に。
  const apt = getAptitude()
  const dbin = String(distanceBin(race.distance))
  const sire = stat?.sire ?? ''
  const bms = stat?.sireOfDam ?? ''
  const sireDistRate = apt?.sireDist?.[sire]?.[dbin] ?? placeRate
  const sireSurfRate = apt?.sireSurf?.[sire]?.[race.surface] ?? placeRate
  const bmsDistRate  = apt?.bmsDist?.[bms]?.[dbin] ?? placeRate

  // --- ローテ（ステップレース）特徴: build_dataset.py agg_rotation と一致 ---
  // 直近5走窓(recentForm/recentGrades/recentPops, 最新が先頭)＋全期間グレード集計から算出。
  const recForm = parseForm(stat?.recentForm, 5)            // 着順（0=無し）
  const recGrades = (stat?.recentGrades ?? '').split('-')   // "G1-G3-..."（最新が先頭）
  const recPops = parseForm(stat?.recentPops, 5)            // 人気（0=無し）
  const prevGradeRank = recGrades[0] ? (GRADE_RANK[recGrades[0]] ?? 1) : 1
  const gradedN = (stat?.g1Races ?? 0) + (stat?.g2Races ?? 0) + (stat?.g3Races ?? 0)
  const gradedP = (stat?.g1Places ?? 0) + (stat?.g2Places ?? 0) + (stat?.g3Places ?? 0)
  const gradedPlaceRate = gradedN > 0 ? gradedP / gradedN : 0.0
  let bestGradedFinish = 18
  let lastGradedGap = 0
  let lastGradedSeen = false
  for (let i = 0; i < 5; i++) {
    const g = recGrades[i]
    if (!g || (GRADE_RANK[g] ?? 1) < 2) continue       // G3以上のみ
    const pos = recForm[i] > 0 ? recForm[i] : 99
    if (pos < bestGradedFinish) bestGradedFinish = pos
    if (!lastGradedSeen) {                               // 最新の重賞（先頭側）
      lastGradedSeen = true
      const pop = recPops[i]
      if (pop > 0) lastGradedGap = Math.max(-17, Math.min(17, pop - pos))
    }
  }

  // 当日情報(odds/popularity/horse_weight/weight_change/当日上がり3F)は数日前予想では
  // 欠損するため特徴量に使わない。馬体重は過去平均、人気・上がり3F・スピードは過去走集計を使用。
  return {
    grade_rank: GRADE_RANK[race.grade] ?? 1,
    surface_bin: race.surface === '芝' ? 1 : 0,
    distance: race.distance,
    distance_bin: distanceBin(race.distance),
    month,
    day_of_year: dayOfYear,

    total_races:  totalRaces,
    total_places: totalPlaces,
    place_rate:   placeRate,
    g1_races:  stat?.g1Races  ?? 0,
    g1_places: stat?.g1Places ?? 0,
    g2_places: stat?.g2Places ?? 0,
    g3_places: stat?.g3Places ?? 0,

    dist_rate:       getJsonRate(stat?.distanceData,  String(race.distance))  ?? placeRate,
    venue_rate:      getJsonRate(stat?.venueData,     race.venue)               ?? VENUE_WIN_RATE[race.venue] ?? 0.111,
    surface_rate:    getJsonRate(stat?.surfaceData,   race.surface)             ?? placeRate,
    course_dist_rate: getJsonRate(stat?.courseDistData, `${race.venue}-${race.surface}-${race.distance}`) ?? placeRate,

    form0: form[0], form1: form[1], form2: form[2], form3: form[3], form4: form[4],
    form_avg: formAvg,
    form_recent3_avg: formRecent3Avg,
    days_since_last: daysSinceLast,
    last_race_pop: stat?.lastRacePopularity ?? DEF_POP,

    jockey_rank:  JOCKEY_RANKS[entry.jockey ?? '']  ?? 3,
    trainer_rank: TRAINER_RANKS[entry.trainer ?? ''] ?? 3,
    horse_weight: stat?.avgHorseWeight ?? 490,

    // オッズ非依存の実力系（reanalyze.js が HorseStat に格納済み）
    best_speed:      stat?.bestSpeed     ?? DEF_SPEED,
    avg_speed3:      stat?.avgSpeed3     ?? DEF_SPEED,
    last_speed:      stat?.lastSpeed     ?? DEF_SPEED,
    avg_pos_ratio:   stat?.avgPosRatio   ?? DEF_POSRATIO,
    front_rate:      stat?.frontRate     ?? DEF_FRONT,
    best_r3f:        stat?.bestR3f        ?? DEF_R3F,
    avg_r3f3:        stat?.avgR3f3        ?? DEF_R3F,
    avg_recent_pop:  stat?.avgRecentPop  ?? DEF_POP,
    best_recent_pop: stat?.bestRecentPop ?? DEF_POP,

    // 血統適性（USE_PEDIGREE で訓練したモデルのみ使用。38特徴量モデルでは無視される）
    sire_dist_rate: sireDistRate,
    sire_surf_rate: sireSurfRate,
    bms_dist_rate:  bmsDistRate,

    // ローテ特徴（USE_ROTATION で訓練したモデルのみ使用。それ以外では meta 駆動で無視される）
    prev_grade_rank: prevGradeRank,
    graded_place_rate: gradedPlaceRate,
    best_graded_finish: bestGradedFinish,
    last_graded_gap: lastGradedGap,
  }
}
