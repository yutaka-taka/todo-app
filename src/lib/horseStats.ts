import { getIntervalBin } from './intervalBins'

export type RaceForStats = {
  name: string
  grade: string
  venue: string
  surface: string
  distance: number
  date: Date
  trackCondition?: string | null
  results: Array<{ horseName: string; finishPosition: number | null; popularity?: number | null; horseWeight?: number | null }>
}

export type HorseStatData = {
  horseName: string
  totalRaces: number
  totalPlaces: number
  g1Races: number
  g1Places: number
  g2Races: number
  g2Places: number
  g3Races: number
  g3Places: number
  distanceData: Record<string, { races: number; places: number }>
  venueData: Record<string, { races: number; places: number }>
  surfaceData: Record<string, { races: number; places: number }>
  raceNameData: Record<string, { races: number; places: number }>
  trackCondData: Record<string, { races: number; places: number }>
  intervalData: Record<string, { races: number; places: number }>
  courseDistData: Record<string, { races: number; places: number }>
  avgHorseWeight?: number | null  // §G 馬体重平均
  weightSamples?: number          // §G サンプル数
  lastRaceDate: Date
  lastRacePopularity?: number | null
  recentForm?: string   // "1-2-1-3-2" newest first
  recentGrades?: string // "G1-G2-G3-G1-G2" corresponding grades
  recentPops?: string   // "1-3-8-2-5" corresponding popularities (0=unknown)
}

// Strip trailing 4-digit year: "天皇賞（春）2023" → "天皇賞（春）"
function normalizeRaceName(name: string): string {
  return name.replace(/\s*\d{4}年?\s*$/, '').trim()
}

export function buildHorseStatsFromResults(races: RaceForStats[]): HorseStatData[] {
  const statsMap = new Map<string, HorseStatData>()
  // Track finish positions (with date/popularity/grade) for recentForm, recentGrades, lastRacePopularity
  const finishesMap = new Map<string, { date: Date; position: number; popularity?: number | null; grade: string }[]>()
  // §G: collect horse weights for average computation
  const weightsMap = new Map<string, number[]>()

  for (const race of races) {
    if (race.results.length === 0) continue
    const raceKey = normalizeRaceName(race.name)
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      if (result.finishPosition == null) continue  // 取消・除外はスキップ
      const placed = result.finishPosition <= 2

      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          horseName: result.horseName,
          totalRaces: 0, totalPlaces: 0,
          g1Races: 0, g1Places: 0,
          g2Races: 0, g2Places: 0,
          g3Races: 0, g3Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {}, trackCondData: {}, intervalData: {}, courseDistData: {},
          lastRaceDate: race.date,
        })
      }
      const stat = statsMap.get(result.horseName)!
      stat.totalRaces++
      if (placed) stat.totalPlaces++
      if (race.grade === 'G1') { stat.g1Races++; if (placed) stat.g1Places++ }
      else if (race.grade === 'G2') { stat.g2Races++; if (placed) stat.g2Places++ }
      else if (race.grade === 'G3') { stat.g3Races++; if (placed) stat.g3Places++ }

      const dk = String(race.distance)
      if (!stat.distanceData[dk]) stat.distanceData[dk] = { races: 0, places: 0 }
      stat.distanceData[dk].races++
      if (placed) stat.distanceData[dk].places++

      if (!stat.venueData[race.venue]) stat.venueData[race.venue] = { races: 0, places: 0 }
      stat.venueData[race.venue].races++
      if (placed) stat.venueData[race.venue].places++

      if (!stat.surfaceData[race.surface]) stat.surfaceData[race.surface] = { races: 0, places: 0 }
      stat.surfaceData[race.surface].races++
      if (placed) stat.surfaceData[race.surface].places++

      if (!stat.raceNameData[raceKey]) stat.raceNameData[raceKey] = { races: 0, places: 0 }
      stat.raceNameData[raceKey].races++
      if (placed) stat.raceNameData[raceKey].places++

      const cdKey = `${race.venue}-${race.surface}-${race.distance}`
      if (!stat.courseDistData[cdKey]) stat.courseDistData[cdKey] = { races: 0, places: 0 }
      stat.courseDistData[cdKey].races++
      if (placed) stat.courseDistData[cdKey].places++

      if (race.trackCondition) {
        const tc = race.trackCondition
        if (!stat.trackCondData[tc]) stat.trackCondData[tc] = { races: 0, places: 0 }
        stat.trackCondData[tc].races++
        if (placed) stat.trackCondData[tc].places++
      }

      if (race.date > stat.lastRaceDate) stat.lastRaceDate = race.date

      // Accumulate finish positions with dates for recentForm
      if (!finishesMap.has(result.horseName)) {
        finishesMap.set(result.horseName, [])
      }
      finishesMap.get(result.horseName)!.push({ date: race.date, position: result.finishPosition ?? 99, popularity: result.popularity ?? null, grade: race.grade })

      // §G: collect horse weights for average computation
      if (result.horseWeight != null && result.horseWeight > 0) {
        if (!weightsMap.has(result.horseName)) weightsMap.set(result.horseName, [])
        weightsMap.get(result.horseName)!.push(result.horseWeight)
      }
    }
  }

  // Compute recentForm, recentGrades, lastRacePopularity, intervalData per horse
  finishesMap.forEach((finishes, horseName) => {
    const stat = statsMap.get(horseName)
    if (!stat || finishes.length === 0) return

    finishes.sort((a, b) => b.date.getTime() - a.date.getTime())
    const recent = finishes.slice(0, 5)
    stat.recentForm = recent.map((f) => f.position).join('-')
    stat.recentGrades = recent.map((f) => f.grade).join('-')
    stat.recentPops = recent.map((f) => f.popularity ?? 0).join('-')
    stat.lastRacePopularity = finishes[0].popularity ?? null

    // 間隔ビン別成績: 日付昇順でペアを取り、次のレースの着順で集計
    const asc = finishes.slice().sort((a, b) => a.date.getTime() - b.date.getTime())
    for (let i = 1; i < asc.length; i++) {
      const days = Math.floor((asc[i].date.getTime() - asc[i - 1].date.getTime()) / 86400000)
      if (days <= 0) continue
      const bin = getIntervalBin(days)
      if (!stat.intervalData[bin]) stat.intervalData[bin] = { races: 0, places: 0 }
      stat.intervalData[bin].races++
      if (asc[i].position <= 2) stat.intervalData[bin].places++
    }
  })

  // §G: compute avgHorseWeight per horse
  weightsMap.forEach((weights, horseName) => {
    const stat = statsMap.get(horseName)
    if (!stat || weights.length === 0) return
    stat.avgHorseWeight = weights.reduce((a, b) => a + b, 0) / weights.length
    stat.weightSamples  = weights.length
  })

  return Array.from(statsMap.values())
}

export function mergeStatData(
  existing: Record<string, { races: number; places: number }>,
  incoming: Record<string, { races: number; places: number }>
): Record<string, { races: number; places: number }> {
  const merged = { ...existing }
  for (const [key, val] of Object.entries(incoming)) {
    merged[key] = merged[key]
      ? { races: merged[key].races + val.races, places: merged[key].places + val.places }
      : val
  }
  return merged
}

// Merge recentForm strings: new positions (from newest batch) prepended to old
export function mergeRecentForm(
  newForm: string | undefined | null,
  existingForm: string | undefined | null,
  maxLen = 7
): string | null {
  const newParts = newForm ? newForm.split('-').filter(Boolean) : []
  const oldParts = existingForm ? existingForm.split('-').filter(Boolean) : []
  const merged = [...newParts, ...oldParts].slice(0, maxLen).join('-')
  return merged || null
}
