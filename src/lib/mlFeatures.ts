/**
 * LightGBM 特徴量ビルダー
 * EntryInput + HorseStat → MLFeatureVector に変換
 */
import type { HorseStat } from '@prisma/client'
import type { MLFeatureVector } from './mlInference'

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

export function buildMLFeatures(
  entry: {
    horseName: string
    jockey?: string | null
    trainer?: string | null
    horseWeight?: number | null
    weightChange?: number | null
    oddsFloat?: number | null
    oddsPopularity?: number | null
    lastThreeFurlong?: number | null
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
  oddsRankInRace: number,
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

  const hw = entry.horseWeight ?? stat?.avgHorseWeight ?? 490
  const avgHw = stat?.avgHorseWeight ?? hw

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
    last_race_pop: stat?.lastRacePopularity ?? 9,

    jockey_rank:  JOCKEY_RANKS[entry.jockey ?? '']  ?? 3,
    trainer_rank: TRAINER_RANKS[entry.trainer ?? ''] ?? 3,

    horse_weight: hw,
    weight_change: entry.weightChange ?? 0,
    weight_vs_avg: hw - avgHw,

    popularity: entry.oddsPopularity ?? 9,
    odds: entry.oddsFloat ?? 15.0,
    odds_log: Math.log1p(entry.oddsFloat ?? 15.0),
    odds_rank: oddsRankInRace,

    rapid_increase: entry.lastThreeFurlong ?? 35.0,
  }
}
