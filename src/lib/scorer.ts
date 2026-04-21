import type { HorseStat } from '@prisma/client'

interface EntryInput {
  horseNumber: number
  horseName: string
  jockey?: string | null
}

interface RaceContext {
  grade: string
  distance: number
  venue: string
  surface: string
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
  }
}

type StatRecord = Record<string, { races: number; places: number }>

export function localScoreHorses(
  entries: EntryInput[],
  race: RaceContext,
  stats: HorseStat[]
): ScoredHorse[] {
  const statMap = new Map(stats.map((s) => [s.horseName, s]))

  const scored = entries.map((entry) => {
    const stat = statMap.get(entry.horseName) ?? null
    return buildScore(entry, race, stat)
  })

  scored.sort((a, b) => b.placeRate - a.placeRate)

  return scored.slice(0, 5).map((s, i) => ({ ...s, rank: i + 1 }))
}

function buildScore(entry: EntryInput, race: RaceContext, stat: HorseStat | null): ScoredHorse {
  if (!stat || stat.totalRaces === 0) {
    const base = 28 + Math.floor(Math.random() * 12)
    return {
      rank: 0,
      horseNumber: entry.horseNumber,
      horseName: entry.horseName,
      placeRate: base,
      factors: {
        recentForm: 'データなし',
        distanceSuitability: '距離実績未収集',
        courseRecord: 'コース実績未収集',
        jockeyStats: entry.jockey ?? '未定',
        reason: 'DBに成績データなし。自己学習を重ねると精度が向上します。',
      },
    }
  }

  const distData = stat.distanceData as StatRecord
  const venueData = stat.venueData as StatRecord
  const surfData = stat.surfaceData as StatRecord

  const baseRate = (stat.totalPlaces / stat.totalRaces) * 100
  let bonus = 0

  // 距離適性
  const dk = String(race.distance)
  const dStat = distData[dk]
  let distanceSuitability = `${race.distance}mの実績なし`
  if (dStat && dStat.races > 0) {
    const r = dStat.places / dStat.races
    if (r >= 0.5) {
      bonus += 15
      distanceSuitability = `◎ ${race.distance}mで${dStat.races}戦${dStat.places}連対（得意距離）`
    } else if (r >= 0.3) {
      bonus += 7
      distanceSuitability = `○ ${race.distance}mで${dStat.races}戦${dStat.places}連対`
    } else {
      bonus -= 5
      distanceSuitability = `△ ${race.distance}mの成績が低調`
    }
  }

  // コース適性
  const vStat = venueData[race.venue]
  let courseRecord = `${race.venue}実績なし`
  if (vStat && vStat.races > 0) {
    const r = vStat.places / vStat.races
    if (r >= 0.4) {
      bonus += 10
      courseRecord = `◎ ${race.venue}で${vStat.races}戦${vStat.places}連対（得意コース）`
    } else {
      bonus += 3
      courseRecord = `${race.venue}で${vStat.races}戦${vStat.places}連対`
    }
  }

  // 馬場適性
  const sStat = surfData[race.surface]
  if (sStat && sStat.races > 0) {
    const r = sStat.places / sStat.races
    if (r >= 0.5) bonus += 8
    else if (r < 0.2) bonus -= 8
  }

  // G1実績
  let g1Note = ''
  if (race.grade === 'G1') {
    if (stat.g1Races === 0) {
      bonus -= 10
      g1Note = 'G1初挑戦'
    } else if (stat.g1Places > 0) {
      bonus += 20
      g1Note = `G1で${stat.g1Races}戦${stat.g1Places}連対の実績`
    } else {
      bonus -= 5
      g1Note = `G1で${stat.g1Races}戦連対なし`
    }
  }

  const finalRate = Math.max(20, Math.min(82, baseRate + bonus))

  const recentForm = stat.recentForm
    ? `直近: ${stat.recentForm}`
    : `通算${stat.totalRaces}戦${stat.totalPlaces}連対`

  const reason = [
    `通算連対率${baseRate.toFixed(0)}%`,
    g1Note,
  ]
    .filter(Boolean)
    .join('、')

  return {
    rank: 0,
    horseNumber: entry.horseNumber,
    horseName: entry.horseName,
    placeRate: Math.round(finalRate * 10) / 10,
    factors: {
      recentForm,
      distanceSuitability,
      courseRecord,
      jockeyStats: entry.jockey ?? '未定',
      reason,
    },
  }
}
