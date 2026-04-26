/**
 * Claude APIなしで動作するローカル自動学習モジュール。
 * レース結果を入力するたびに呼び出し、HorseStatと因子重みを更新する。
 */
import { prisma } from '@/lib/db'
import { DEFAULT_WEIGHTS } from '@/lib/scorer'
import type { LocalWeights } from '@/lib/scorer'

type StatRecord = Record<string, { races: number; places: number }>

interface InsightsJson {
  keyFindings?: string[]
  localWeights?: Partial<LocalWeights>
  localAccuracy?: number
  lastLearnedAt?: string
}

// ========== 重み調整 ==========

interface FactorStat { hits: number; total: number }
type FactorStatsMap = Record<keyof LocalWeights, FactorStat>

async function computeFactorAccuracy(windowSize = 40): Promise<FactorStatsMap> {
  const empty = (): FactorStat => ({ hits: 0, total: 0 })
  const stats: FactorStatsMap = {
    recentFormMult:       empty(),
    distanceMult:         empty(),
    venueMult:            empty(),
    surfaceMult:          empty(),
    g1Mult:               empty(),
    ageMult:              empty(),
    jockeyMult:           empty(),
    raceAffinityMult:     empty(),
    trackCondMult:        empty(),
    // prepMult は固定ボーナスのため重み調整対象外
    // v274 新因子
    gateMult:             empty(),
    trainerMult:          empty(),
    lastThreeFurlongMult: empty(),
    restIntervalMult:     empty(),
    courseFeatureMult:    empty(),
    paceMult:             empty(),
    // v336
    oddsMult:             empty(),
  }

  const races = await prisma.race.findMany({
    where: { predictions: { some: {} }, results: { some: {} } },
    include: {
      predictions: { orderBy: { rank: 'asc' }, take: 5 },
      results:     { orderBy: { finishPosition: 'asc' }, take: 2 },
    },
    orderBy: { date: 'desc' },
    take: windowSize,
  })

  for (const race of races) {
    const actualTop2 = race.results
      .filter((r) => r.finishPosition <= 2)
      .map((r) => r.horseName)
    if (actualTop2.length < 2) continue

    for (const pred of race.predictions.slice(0, 5)) {
      const isHit = actualTop2.includes(pred.horseName)
      const bonuses = (pred.factors as Record<string, unknown> | null)?._bonuses as
        | Record<string, number>
        | undefined
      if (!bonuses) continue

      const factorMap: [keyof LocalWeights, number][] = [
        ['recentFormMult',       bonuses.recentForm       ?? 0],
        ['distanceMult',         bonuses.distance         ?? 0],
        ['venueMult',            bonuses.venue            ?? 0],
        ['surfaceMult',          bonuses.surface          ?? 0],
        ['g1Mult',               bonuses.g1               ?? 0],
        ['ageMult',              bonuses.age              ?? 0],
        ['jockeyMult',           bonuses.jockey           ?? 0],
        ['raceAffinityMult',     bonuses.raceAffinity     ?? 0],
        ['trackCondMult',        bonuses.trackCond        ?? 0],
        ['gateMult',             bonuses.gate             ?? 0],
        ['trainerMult',          bonuses.trainer          ?? 0],
        ['lastThreeFurlongMult', bonuses.lastThreeFurlong ?? 0],
        ['restIntervalMult',     bonuses.restInterval     ?? 0],
        ['courseFeatureMult',    bonuses.courseFeature    ?? 0],
        ['paceMult',             bonuses.pace             ?? 0],
        ['oddsMult',             bonuses.odds             ?? 0],
      ]

      for (const [key, val] of factorMap) {
        if (Math.abs(val) > 2) {
          stats[key].total++
          // 正ボーナス→的中で正解、負ボーナス→非的中で正解（両方向を学習）
          const correctSignal = val > 0 ? isHit : !isHit
          if (correctSignal) stats[key].hits++
        }
      }
    }
  }

  return stats
}

function nudgeWeights(current: LocalWeights, factorStats: FactorStatsMap): LocalWeights {
  const next = { ...current }
  const BASE_STEP = 0.09
  const MIN = 0.3
  const MAX = 2.0

  for (const key of Object.keys(factorStats) as (keyof LocalWeights)[]) {
    const { hits, total } = factorStats[key]
    if (total < 5) continue
    const hitRate = hits / total
    let delta = 0
    if (hitRate > 0.58) {
      // 精度が高い因子を強化: 偏差が大きいほどステップ大
      delta = BASE_STEP * (1 + (hitRate - 0.58) * 2.5)
    } else if (hitRate < 0.35) {
      // 精度が低い因子を弱体化
      delta = -BASE_STEP * (1 + (0.35 - hitRate) * 2.5)
    }
    next[key] = Math.max(MIN, Math.min(MAX, current[key] + delta))
    next[key] = Math.round(next[key] * 100) / 100
  }

  return next
}

// ========== HorseStat更新ヘルパー ==========

function mergeStatRecord(existing: StatRecord, key: string, placed: boolean): StatRecord {
  const prev = existing[key] ?? { races: 0, places: 0 }
  return { ...existing, [key]: { races: prev.races + 1, places: prev.places + (placed ? 1 : 0) } }
}

function prependForm(existingForm: string | null, position: number, maxLen = 7): string {
  const parts = existingForm ? existingForm.split('-').map(Number).filter((n) => n > 0) : []
  return [position, ...parts].slice(0, maxLen).join('-')
}

// ========== メイン関数 ==========

export async function autoLearnFromNewResult({
  raceId,
  winnerName,
  secondName,
  raceName,
  grade,
  venue,
  surface,
  distance,
  raceDate,
}: {
  raceId?: string
  winnerName: string
  secondName: string
  raceName: string
  grade: string
  venue: string
  surface: string
  distance: number
  raceDate: Date
}): Promise<{
  horsesUpdated: number
  weightsUpdated: boolean
  newVersion: number
  localAccuracy: number
}> {
  const isG1 = grade === 'G1'
  const dk = String(distance)
  const raceKey = raceName.replace(/\s*\d{4}年?\s*$/, '').trim()
  let horsesUpdated = 0

  // 1着・2着馬のHorseStatを更新
  for (const [name, pos] of [[winnerName, 1], [secondName, 2]] as [string, number][]) {
    try {
      const existing = await prisma.horseStat.findUnique({ where: { horseName: name } })
      if (existing) {
        await prisma.horseStat.update({
          where: { horseName: name },
          data: {
            totalRaces:   existing.totalRaces + 1,
            totalPlaces:  existing.totalPlaces + 1,
            g1Races:      isG1 ? existing.g1Races + 1  : existing.g1Races,
            g1Places:     isG1 ? existing.g1Places + 1 : existing.g1Places,
            distanceData: mergeStatRecord(existing.distanceData as StatRecord, dk, true),
            venueData:    mergeStatRecord(existing.venueData    as StatRecord, venue, true),
            surfaceData:  mergeStatRecord(existing.surfaceData  as StatRecord, surface, true),
            raceNameData: mergeStatRecord(existing.raceNameData as StatRecord, raceKey, true),
            recentForm:   prependForm(existing.recentForm, pos),
            lastRaceDate: raceDate,
          },
        })
      } else {
        await prisma.horseStat.create({
          data: {
            horseName:    name,
            totalRaces:   1,
            totalPlaces:  1,
            g1Races:      isG1 ? 1 : 0,
            g1Places:     isG1 ? 1 : 0,
            distanceData: { [dk]: { races: 1, places: 1 } },
            venueData:    { [venue]: { races: 1, places: 1 } },
            surfaceData:  { [surface]: { races: 1, places: 1 } },
            raceNameData: { [raceKey]: { races: 1, places: 1 } },
            recentForm:   String(pos),
            lastRaceDate: raceDate,
          },
        })
      }
      horsesUpdated++
    } catch { /* 個別エラーはスキップ */ }
  }

  // 入着しなかった馬のtotalRacesを更新（勝率の膨張を防ぐ）
  // 既存のHorseStatがある馬のみ更新（新規作成はしない）
  if (raceId) {
    try {
      const entries = await prisma.raceEntry.findMany({ where: { raceId } })
      const placingNames = new Set([winnerName, secondName])
      for (const entry of entries) {
        if (placingNames.has(entry.horseName)) continue
        const existing = await prisma.horseStat.findUnique({ where: { horseName: entry.horseName } })
        if (!existing) continue
        try {
          await prisma.horseStat.update({
            where: { horseName: entry.horseName },
            data: {
              totalRaces:   existing.totalRaces + 1,
              g1Races:      isG1 ? existing.g1Races + 1 : existing.g1Races,
              distanceData: mergeStatRecord(existing.distanceData as StatRecord, dk, false),
              venueData:    mergeStatRecord(existing.venueData    as StatRecord, venue, false),
              surfaceData:  mergeStatRecord(existing.surfaceData  as StatRecord, surface, false),
              raceNameData: mergeStatRecord(existing.raceNameData as StatRecord, raceKey, false),
              lastRaceDate: raceDate,
            },
          })
        } catch { /* skip */ }
      }
    } catch { /* RaceEntry取得失敗はスキップ */ }
  }

  // 因子精度分析 → 重み調整
  const factorStats = await computeFactorAccuracy()

  const currentConfig = await prisma.algorithmConfig.findFirst({
    where: { isActive: true },
    orderBy: { version: 'desc' },
  })

  let currentWeights: LocalWeights = { ...DEFAULT_WEIGHTS }
  let currentInsights: InsightsJson = {}

  if (currentConfig?.insights) {
    try {
      const parsed = JSON.parse(currentConfig.insights as string) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        currentInsights = parsed as InsightsJson
        if (currentInsights.localWeights) {
          currentWeights = { ...DEFAULT_WEIGHTS, ...currentInsights.localWeights }
        }
      } else if (Array.isArray(parsed)) {
        currentInsights = { keyFindings: parsed as string[] }
      }
    } catch { /* 旧フォーマットはスキップ */ }
  }

  const totalFactorData = Object.values(factorStats).reduce((s, v) => s + v.total, 0)
  const newWeights = totalFactorData >= 15 ? nudgeWeights(currentWeights, factorStats) : currentWeights
  const weightsUpdated = JSON.stringify(newWeights) !== JSON.stringify(currentWeights)

  // 直近50レースで的中率を再計算
  const recentRaces = await prisma.race.findMany({
    where: { predictions: { some: {} }, results: { some: {} } },
    include: {
      predictions: { orderBy: { rank: 'asc' }, take: 5 },
      results:     { orderBy: { finishPosition: 'asc' }, take: 2 },
    },
    orderBy: { date: 'desc' },
    take: 50,
  })

  let completeHits = 0, halfHits = 0
  for (const r of recentRaces) {
    const top5   = r.predictions.slice(0, 5).map((p) => p.horseName)
    const actual = r.results.filter((res) => res.finishPosition <= 2).map((res) => res.horseName)
    if (actual.length < 2) continue
    const hits = actual.filter((a) => top5.includes(a)).length
    if (hits === 2) completeHits++
    else if (hits === 1) halfHits++
  }
  const total = recentRaces.length
  const localAccuracy = total > 0
    ? Math.round((completeHits * 2 + halfHits) / (total * 2) * 1000) / 10
    : (currentConfig?.accuracy ?? 0)

  // AlgorithmConfigを新バージョンで保存
  const newVersion = (currentConfig?.version ?? 0) + 1
  const newInsights: InsightsJson = {
    ...currentInsights,
    localWeights:   newWeights,
    localAccuracy,
    lastLearnedAt:  new Date().toISOString(),
  }

  await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
  await prisma.algorithmConfig.create({
    data: {
      version:       newVersion,
      isActive:      true,
      rules:         currentConfig?.rules ?? '',
      insights:      JSON.stringify(newInsights),
      analyzedCount: (currentConfig?.analyzedCount ?? 0) + 1,
      accuracy:      localAccuracy,
    },
  })

  return { horsesUpdated, weightsUpdated, newVersion, localAccuracy }
}

export async function getLocalWeights(): Promise<LocalWeights> {
  try {
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    if (config?.insights) {
      const parsed = JSON.parse(config.insights as string) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const ins = parsed as InsightsJson
        if (ins.localWeights) return { ...DEFAULT_WEIGHTS, ...ins.localWeights }
      }
    }
  } catch { /* fallback to defaults */ }
  return { ...DEFAULT_WEIGHTS }
}
