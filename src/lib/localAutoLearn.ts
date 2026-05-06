/**
 * Claude APIなしで動作するローカル自動学習モジュール。
 * レース結果を入力するたびに呼び出し、HorseStatと因子重みを更新する。
 */
import { prisma } from '@/lib/db'
import { DEFAULT_WEIGHTS } from '@/lib/scorer'
import type { LocalWeights } from '@/lib/scorer'
import { getIntervalBin } from '@/lib/intervalBins'

type StatRecord = Record<string, { races: number; places: number }>

interface InsightsJson {
  keyFindings?: string[]
  localWeights?: Partial<LocalWeights>
  gradeWeights?: {
    G1?: Partial<LocalWeights>
    G2G3?: Partial<LocalWeights>
  }
  localAccuracy?: number
  lastLearnedAt?: string
  globalIntervalBaseline?: Record<string, number>  // §A ビン別全馬連対率
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
    bloodlineMult:        empty(),
    // v341 新因子
    weightAbsMult:        empty(),
    jockeyVenueDistMult:  empty(),
    // §D
    finishGapMult:        empty(),
    // §F
    courseDistMult:       empty(),
    // §B
    oddsGapMult:          empty(),
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
        ['bloodlineMult',        bonuses.bloodline        ?? 0],
        ['weightAbsMult',        bonuses.weightAbs        ?? 0],
        ['jockeyVenueDistMult',  bonuses.jockeyVenueDist  ?? 0],
        ['finishGapMult',        bonuses.finishGap        ?? 0],
        ['courseDistMult',       bonuses.courseDist       ?? 0],
        ['oddsGapMult',          bonuses.oddsGap          ?? 0],
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

function prependGrades(existingGrades: string | null, grade: string, maxLen = 7): string {
  const parts = existingGrades ? existingGrades.split('-').filter(Boolean) : []
  return [grade, ...parts].slice(0, maxLen).join('-')
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
  trackCondition,
  participants,
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
  trackCondition?: string | null
  participants?: { name: string; popularity?: number | null }[]  // §D recentPops更新用
}): Promise<{
  horsesUpdated: number
  weightsUpdated: boolean
  newVersion: number
  localAccuracy: number
}> {
  const isG1 = grade === 'G1'
  const isG2 = grade === 'G2'
  const isG3 = grade === 'G3'
  const dk = String(distance)
  const raceKey = raceName.replace(/\s*\d{4}年?\s*$/, '').trim()
  let horsesUpdated = 0

  // 1着・2着馬のHorseStatを更新
  for (const [name, pos] of [[winnerName, 1], [secondName, 2]] as [string, number][]) {
    try {
      const existing = await prisma.horseStat.findUnique({ where: { horseName: name } })
      if (existing) {
        // 出走間隔を計算してintervalDataを更新
        const existingLastDate = existing.lastRaceDate ? new Date(existing.lastRaceDate) : null
        const intervalDays = existingLastDate
          ? Math.floor((new Date(raceDate).getTime() - existingLastDate.getTime()) / 86400000)
          : 0
        const intervalUpdate = intervalDays > 0 ? {
          intervalData: mergeStatRecord((existing as unknown as { intervalData?: StatRecord }).intervalData ?? {}, getIntervalBin(intervalDays), true),
        } : {}

        // §D: recentPops 更新（participants から今走の人気を取得）
        const thisPop = participants?.find((p) => p.name === name)?.popularity ?? null
        const existingPops = (existing as unknown as { recentPops?: string | null }).recentPops ?? null
        const newRecentPops = prependForm(existingPops, thisPop ?? 0)

        // §F: courseDistData 更新
        const cdKey = `${venue}-${surface}-${distance}`
        const courseDistUpdate = {
          courseDistData: mergeStatRecord(
            (existing as unknown as { courseDistData?: StatRecord }).courseDistData ?? {},
            cdKey, true
          ),
        }

        await prisma.horseStat.update({
          where: { horseName: name },
          data: {
            totalRaces:   existing.totalRaces + 1,
            totalPlaces:  existing.totalPlaces + 1,
            g1Races:      isG1 ? existing.g1Races + 1  : existing.g1Races,
            g1Places:     isG1 ? existing.g1Places + 1 : existing.g1Places,
            g2Races:      isG2 ? existing.g2Races + 1  : existing.g2Races,
            g2Places:     isG2 ? existing.g2Places + 1 : existing.g2Places,
            g3Races:      isG3 ? existing.g3Races + 1  : existing.g3Races,
            g3Places:     isG3 ? existing.g3Places + 1 : existing.g3Places,
            distanceData:  mergeStatRecord(existing.distanceData  as StatRecord, dk, true),
            venueData:     mergeStatRecord(existing.venueData     as StatRecord, venue, true),
            surfaceData:   mergeStatRecord(existing.surfaceData   as StatRecord, surface, true),
            raceNameData:  mergeStatRecord(existing.raceNameData  as StatRecord, raceKey, true),
            ...(trackCondition ? { trackCondData: mergeStatRecord(existing.trackCondData as StatRecord ?? {}, trackCondition, true) } : {}),
            ...intervalUpdate,
            ...courseDistUpdate,
            recentForm:   prependForm(existing.recentForm, pos),
            recentGrades: prependGrades(existing.recentGrades ?? null, grade),
            recentPops:   newRecentPops,
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
            g2Races:      isG2 ? 1 : 0,
            g2Places:     isG2 ? 1 : 0,
            g3Races:      isG3 ? 1 : 0,
            g3Places:     isG3 ? 1 : 0,
            distanceData:   { [dk]: { races: 1, places: 1 } },
            venueData:      { [venue]: { races: 1, places: 1 } },
            surfaceData:    { [surface]: { races: 1, places: 1 } },
            raceNameData:   { [raceKey]: { races: 1, places: 1 } },
            trackCondData:  trackCondition ? { [trackCondition]: { races: 1, places: 1 } } : {},
            courseDistData: { [`${venue}-${surface}-${distance}`]: { races: 1, places: 1 } },
            recentForm:   String(pos),
            recentGrades: grade,
            recentPops:   String(participants?.find((p) => p.name === name)?.popularity ?? 0),
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
          const existingLastDateNP = existing.lastRaceDate ? new Date(existing.lastRaceDate) : null
          const intervalDaysNP = existingLastDateNP
            ? Math.floor((new Date(raceDate).getTime() - existingLastDateNP.getTime()) / 86400000)
            : 0
          const intervalUpdateNP = intervalDaysNP > 0 ? {
            intervalData: mergeStatRecord((existing as unknown as { intervalData?: StatRecord }).intervalData ?? {}, getIntervalBin(intervalDaysNP), false),
          } : {}

          await prisma.horseStat.update({
            where: { horseName: entry.horseName },
            data: {
              totalRaces:   existing.totalRaces + 1,
              g1Races:      isG1 ? existing.g1Races + 1 : existing.g1Races,
              g2Races:      isG2 ? existing.g2Races + 1 : existing.g2Races,
              g3Races:      isG3 ? existing.g3Races + 1 : existing.g3Races,
              distanceData:  mergeStatRecord(existing.distanceData  as StatRecord, dk, false),
              venueData:     mergeStatRecord(existing.venueData     as StatRecord, venue, false),
              surfaceData:   mergeStatRecord(existing.surfaceData   as StatRecord, surface, false),
              raceNameData:  mergeStatRecord(existing.raceNameData  as StatRecord, raceKey, false),
              ...(trackCondition ? { trackCondData: mergeStatRecord(existing.trackCondData as StatRecord ?? {}, trackCondition, false) } : {}),
              ...intervalUpdateNP,
              courseDistData: mergeStatRecord(
                (existing as unknown as { courseDistData?: StatRecord }).courseDistData ?? {},
                `${venue}-${surface}-${distance}`, false
              ),
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

// grade を渡すとグレード別最適重みを返す（G1 or G2/G3）。
// 未設定時は全グレード共通重み（localWeights）にフォールバック。
export async function getLocalWeights(grade?: string): Promise<LocalWeights> {
  try {
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    if (config?.insights) {
      const parsed = JSON.parse(config.insights as string) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const ins = parsed as InsightsJson
        const base: LocalWeights = ins.localWeights
          ? { ...DEFAULT_WEIGHTS, ...ins.localWeights }
          : { ...DEFAULT_WEIGHTS }
        // グレード別重みが存在する場合は共通重みに上書きマージ
        if (grade && ins.gradeWeights) {
          const gradeKey = grade === 'G1' ? 'G1' : 'G2G3'
          const gradeSpecific = ins.gradeWeights[gradeKey]
          if (gradeSpecific) return { ...base, ...gradeSpecific }
        }
        return base
      }
    }
  } catch { /* fallback to defaults */ }
  return { ...DEFAULT_WEIGHTS }
}

// (#2) AlgorithmConfig.insights から calibration曲線を取得
// 予測placeRateを実連対率にマッピングして表示の現実性を高める
export async function getLocalCalibration(): Promise<{ points: { pred: number; actual: number }[] } | null> {
  try {
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    if (config?.insights) {
      const parsed = JSON.parse(config.insights as string) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const ins = parsed as { calibration?: { pred: number; actual: number }[] | { points: { pred: number; actual: number }[] } }
        if (ins.calibration) {
          if (Array.isArray(ins.calibration)) return { points: ins.calibration }
          if (typeof ins.calibration === 'object' && Array.isArray((ins.calibration as { points?: unknown }).points)) {
            return ins.calibration as { points: { pred: number; actual: number }[] }
          }
        }
      }
    }
  } catch { /* silent */ }
  return null
}

// §E: キャリブレーション曲線を再構築（予測placeRate→実連対率の補正テーブル）
// 全予測×結果ペアをビン別（5pt刻み, 20-70+）に集計し、単調増加を保証して保存する
export async function rebuildCalibrationCurve(): Promise<void> {
  try {
    const races = await prisma.race.findMany({
      where: { predictions: { some: {} }, results: { some: {} } },
      include: {
        predictions: { orderBy: { rank: 'asc' }, take: 10 },
        results: { orderBy: { finishPosition: 'asc' }, take: 2 },
      },
      orderBy: { date: 'desc' },
      take: 200,
    })

    // ビン境界: 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70+
    const binEdges = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]
    const bins: { pred: number; hits: number; total: number }[] = binEdges.map((e) => ({ pred: e, hits: 0, total: 0 }))

    for (const race of races) {
      const actualTop2 = race.results
        .filter((r) => r.finishPosition <= 2)
        .map((r) => r.horseName)

      for (const pred of race.predictions) {
        const rate = pred.placeRate
        // どのビンに属するか
        let binIdx = binEdges.length - 1
        for (let i = 0; i < binEdges.length - 1; i++) {
          if (rate < binEdges[i + 1]) { binIdx = i; break }
        }
        bins[binIdx].total++
        if (actualTop2.includes(pred.horseName)) bins[binIdx].hits++
      }
    }

    // 実連対率を計算（データ不足ビンは線形補間で埋める）
    const raw: { pred: number; actual: number | null }[] = bins.map((b) => ({
      pred: b.pred + 2.5,  // ビン中心値
      actual: b.total >= 5 ? (b.hits / b.total) * 100 : null,
    }))

    // データなしビンを隣接値で補間
    const filled = raw.slice()
    for (let i = 0; i < filled.length; i++) {
      if (filled[i].actual != null) continue
      const prev = filled.slice(0, i).reverse().find((x) => x.actual != null)
      const next = filled.slice(i + 1).find((x) => x.actual != null)
      if (prev && next) {
        const t = (filled[i].pred - prev.pred) / (next.pred - prev.pred)
        filled[i] = { ...filled[i], actual: prev.actual! + t * (next.actual! - prev.actual!) }
      } else if (prev) {
        filled[i] = { ...filled[i], actual: prev.actual! }
      } else if (next) {
        filled[i] = { ...filled[i], actual: next.actual! }
      }
    }

    const withActual = filled.filter((x) => x.actual != null) as { pred: number; actual: number }[]
    if (withActual.length < 2) return

    // 単調増加を保証（isotonic: 後ろが前以下なら前に合わせる）
    for (let i = 1; i < withActual.length; i++) {
      if (withActual[i].actual < withActual[i - 1].actual) {
        withActual[i].actual = withActual[i - 1].actual
      }
    }

    // AlgorithmConfig.insights に保存
    const activeConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    if (!activeConfig) return

    let ins: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(activeConfig.insights as string ?? '{}')
      ins = Array.isArray(parsed) ? { keyFindings: parsed } : (parsed as Record<string, unknown>)
    } catch { /* empty */ }

    ins.calibration = withActual
    await prisma.algorithmConfig.update({
      where: { id: activeConfig.id },
      data: { insights: JSON.stringify(ins) },
    })
  } catch (e) {
    console.warn('rebuildCalibrationCurve failed:', e)
  }
}

// §A AlgorithmConfig.insights から全馬ビン別連対率を取得
export async function getGlobalIntervalBaseline(): Promise<Record<string, number> | null> {
  try {
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    if (config?.insights) {
      const parsed = JSON.parse(config.insights as string) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const ins = parsed as InsightsJson
        return ins.globalIntervalBaseline ?? null
      }
    }
  } catch { /* silent */ }
  return null
}
