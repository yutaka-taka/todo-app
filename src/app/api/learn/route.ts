import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { analyzeRacesForLearning } from '@/lib/ai'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

const BATCH_SIZE = 3

export async function POST() {
  try {
    const today = new Date()

    const unanalyzedRaces = await prisma.race.findMany({
      where: {
        date: { lt: today },
        analyzed: false,
        grade: { in: ['G1', 'G2', 'G3'] },
      },
      orderBy: { date: 'desc' },
      take: BATCH_SIZE,
      include: {
        results: { orderBy: { finishPosition: 'asc' } },
        entries: { orderBy: { horseNumber: 'asc' } },
      },
    })

    if (unanalyzedRaces.length === 0) {
      const totalAnalyzed = await prisma.race.count({ where: { analyzed: true } })
      const horseStatCount = await prisma.horseStat.count()
      return NextResponse.json({
        analyzed: 0,
        totalAnalyzed,
        horseStatCount,
        message: '分析が済んでいない重賞レースはありません。',
        summary: '全レース分析済みです。',
      })
    }

    const currentConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    const currentRules = currentConfig?.rules ?? '初期設定'
    const currentVersion = currentConfig?.version ?? 0

    // レースデータをテキスト化
    const racesData = unanalyzedRaces
      .map((race) => {
        const dateStr = format(new Date(race.date), 'yyyy年M月d日', { locale: ja })
        const resultsText =
          race.results.length > 0
            ? race.results
                .slice(0, 5)
                .map(
                  (r) =>
                    `  ${r.finishPosition}着: ${r.horseName}${r.jockey ? ` (${r.jockey})` : ''}${r.popularity ? ` ${r.popularity}番人気` : ''}`
                )
                .join('\n')
            : '  ※結果データなし（AIが知識から分析）'
        const entriesText =
          race.entries.length > 0
            ? `出走馬: ${race.entries.map((e) => `${e.horseNumber}番${e.horseName}`).join(', ')}`
            : ''
        return `---\nレース名: ${race.name}\n開催日: ${dateStr}\n競馬場: ${race.venue} ${race.surface}${race.distance}m ${race.grade}\n${entriesText}\n着順結果:\n${resultsText}`
      })
      .join('\n\n')

    // Claude で学習
    const learningResult = await analyzeRacesForLearning({ racesData, currentRules })

    // 新バージョンのアルゴリズム設定を保存
    const newVersion = currentVersion + 1
    await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
    await prisma.algorithmConfig.create({
      data: {
        version: newVersion,
        isActive: true,
        rules: learningResult.updatedRules,
        insights: JSON.stringify(learningResult.newInsights),
        analyzedCount: (currentConfig?.analyzedCount ?? 0) + unanalyzedRaces.length,
        accuracy: learningResult.estimatedAccuracy,
      },
    })

    // 馬別成績データをDBに蓄積（upsert）
    let horsesSaved = 0
    for (const hs of learningResult.horseStats) {
      if (!hs.horseName || hs.horseName.trim() === '') continue
      try {
        const existing = await prisma.horseStat.findUnique({
          where: { horseName: hs.horseName }
        })
        if (existing) {
          // マージ: より大きい値で更新（累積）
          const mergedDistanceData = mergeStatData(
            existing.distanceData as Record<string, { races: number; places: number }>,
            hs.distanceData ?? {}
          )
          const mergedVenueData = mergeStatData(
            existing.venueData as Record<string, { races: number; places: number }>,
            hs.venueData ?? {}
          )
          const mergedSurfaceData = mergeStatData(
            existing.surfaceData as Record<string, { races: number; places: number }>,
            hs.surfaceData ?? {}
          )
          await prisma.horseStat.update({
            where: { horseName: hs.horseName },
            data: {
              totalRaces: Math.max(existing.totalRaces, hs.totalRaces ?? 0),
              totalPlaces: Math.max(existing.totalPlaces, hs.totalPlaces ?? 0),
              g1Races: Math.max(existing.g1Races, hs.g1Races ?? 0),
              g1Places: Math.max(existing.g1Places, hs.g1Places ?? 0),
              distanceData: mergedDistanceData,
              venueData: mergedVenueData,
              surfaceData: mergedSurfaceData,
              recentForm: hs.recentForm || existing.recentForm,
              lastRaceDate: hs.lastRaceDate ? new Date(hs.lastRaceDate) : existing.lastRaceDate,
            },
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces ?? 0,
              totalPlaces: hs.totalPlaces ?? 0,
              g1Races: hs.g1Races ?? 0,
              g1Places: hs.g1Places ?? 0,
              distanceData: hs.distanceData ?? {},
              venueData: hs.venueData ?? {},
              surfaceData: hs.surfaceData ?? {},
              recentForm: hs.recentForm ?? null,
              lastRaceDate: hs.lastRaceDate ? new Date(hs.lastRaceDate) : null,
            },
          })
        }
        horsesSaved++
      } catch {
        // 個別の馬データ保存エラーはスキップ
      }
    }

    // 分析ログ保存＆分析済みマーク
    for (const race of unanalyzedRaces) {
      await prisma.analysisLog.upsert({
        where: { raceId: race.id },
        update: {
          analysis: learningResult.summary,
          insights: learningResult.keyPatterns.join('\n'),
          accuracy: learningResult.estimatedAccuracy,
        },
        create: {
          raceId: race.id,
          analysis: learningResult.summary,
          insights: learningResult.keyPatterns.join('\n'),
          accuracy: learningResult.estimatedAccuracy,
        },
      })
      await prisma.race.update({ where: { id: race.id }, data: { analyzed: true } })
    }

    const remainingCount = await prisma.race.count({
      where: { date: { lt: today }, analyzed: false, grade: { in: ['G1', 'G2', 'G3'] } },
    })
    const totalAnalyzed = await prisma.race.count({ where: { analyzed: true } })
    const horseStatCount = await prisma.horseStat.count()

    return NextResponse.json({
      analyzed: unanalyzedRaces.length,
      totalAnalyzed,
      remaining: remainingCount,
      newVersion,
      estimatedAccuracy: learningResult.estimatedAccuracy,
      summary: learningResult.summary,
      keyPatterns: learningResult.keyPatterns,
      newInsightsCount: learningResult.newInsights.length,
      horsesSaved,
      horseStatCount,
      raceNames: unanalyzedRaces.map((r) => r.name),
      // 何件でローカル予想に切り替わるか
      localModeThreshold: 100,
      localModeReady: horseStatCount >= 100,
    })
  } catch (error) {
    console.error('Learn API error:', error)
    const message = error instanceof Error ? error.message : '自己学習に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  try {
    const today = new Date()
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    const totalRaces = await prisma.race.count({
      where: { date: { lt: today }, grade: { in: ['G1', 'G2', 'G3'] } },
    })
    const analyzedRaces = await prisma.race.count({
      where: { date: { lt: today }, analyzed: true, grade: { in: ['G1', 'G2', 'G3'] } },
    })
    const unanalyzedRaces = await prisma.race.count({
      where: { date: { lt: today }, analyzed: false, grade: { in: ['G1', 'G2', 'G3'] } },
    })
    const horseStatCount = await prisma.horseStat.count()

    return NextResponse.json({
      version: config?.version ?? 0,
      analyzedCount: config?.analyzedCount ?? 0,
      accuracy: config?.accuracy,
      totalRaces,
      analyzedRaces,
      unanalyzedRaces,
      horseStatCount,
      localModeThreshold: 100,
      localModeReady: horseStatCount >= 100,
    })
  } catch (error) {
    console.error('Learn status error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}

// 既存統計と新規統計をマージ（最大値を採用）
function mergeStatData(
  existing: Record<string, { races: number; places: number }>,
  incoming: Record<string, { races: number; places: number }>
): Record<string, { races: number; places: number }> {
  const merged = { ...existing }
  for (const [key, val] of Object.entries(incoming)) {
    if (merged[key]) {
      merged[key] = {
        races: Math.max(merged[key].races, val.races),
        places: Math.max(merged[key].places, val.places),
      }
    } else {
      merged[key] = val
    }
  }
  return merged
}
