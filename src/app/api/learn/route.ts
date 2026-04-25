import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { analyzeRacesForLearning } from '@/lib/ai'
import { buildHorseStatsFromResults, mergeStatData, mergeRecentForm } from '@/lib/horseStats'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

const BATCH_SIZE = 3

export async function POST() {
  try {
    const today = new Date()

    const unanalyzedRaces = await prisma.race.findMany({
      where: { date: { lt: today }, analyzed: false, grade: { in: ['G1', 'G2', 'G3'] } },
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
        analyzed: 0, totalAnalyzed, horseStatCount,
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

    const racesData = unanalyzedRaces
      .map((race) => {
        const dateStr = format(new Date(race.date), 'yyyy年M月d日', { locale: ja })
        const resultsText =
          race.results.length > 0
            ? race.results.slice(0, 5).map(
                (r) => `  ${r.finishPosition}着: ${r.horseName}${r.jockey ? ` (${r.jockey})` : ''}${r.popularity ? ` ${r.popularity}番人気` : ''}`
              ).join('\n')
            : '  ※結果データなし（AIが知識から分析）'
        const entriesText =
          race.entries.length > 0
            ? `出走馬: ${race.entries.map((e) => `${e.horseNumber}番${e.horseName}`).join(', ')}`
            : ''
        return `---\nレース名: ${race.name}\n開催日: ${dateStr}\n競馬場: ${race.venue} ${race.surface}${race.distance}m ${race.grade}\n${entriesText}\n着順結果:\n${resultsText}`
      })
      .join('\n\n')

    // Claude でパターン分析 + 簡易馬別成績（APIキーがある場合のみ）
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY
    let learningResult
    if (hasApiKey) {
      learningResult = await analyzeRacesForLearning({ racesData, currentRules })
    } else {
      learningResult = {
        horseStats: [],
        newInsights: [],
        updatedRules: currentRules,
        keyPatterns: unanalyzedRaces.map((r) => `${r.name}を処理`),
        estimatedAccuracy: currentConfig?.accuracy ?? 0,
        summary: `Claude APIキー未設定のため、馬別データのみ蓄積しました（${unanalyzedRaces.length}レース）。`,
      }
    }

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

    // ① 実際のレース結果から詳細な馬別成績を構築（優先）
    const realStats = buildHorseStatsFromResults(
      unanalyzedRaces.map((r) => ({
        name: r.name,
        grade: r.grade,
        venue: r.venue,
        surface: r.surface,
        distance: r.distance,
        date: r.date,
        results: r.results.map((res) => ({ horseName: res.horseName, finishPosition: res.finishPosition, popularity: res.popularity ?? null })),
      }))
    )
    const realStatNames = new Set(realStats.map((s) => s.horseName))

    // ② Claude の簡易成績（実データにない馬のみ対象）
    const claudeStats = (learningResult.horseStats ?? []).filter(
      (h) => h.horseName?.trim() && !realStatNames.has(h.horseName) && h.totalRaces > 0
    )

    let horsesSaved = 0

    // 実データを保存（累積加算）
    for (const hs of realStats) {
      try {
        const existing = await prisma.horseStat.findUnique({ where: { horseName: hs.horseName } })
        if (existing) {
          await prisma.horseStat.update({
            where: { horseName: hs.horseName },
            data: {
              totalRaces: existing.totalRaces + hs.totalRaces,
              totalPlaces: existing.totalPlaces + hs.totalPlaces,
              g1Races: existing.g1Races + hs.g1Races,
              g1Places: existing.g1Places + hs.g1Places,
              distanceData: mergeStatData(
                existing.distanceData as Record<string, { races: number; places: number }>,
                hs.distanceData
              ),
              venueData: mergeStatData(
                existing.venueData as Record<string, { races: number; places: number }>,
                hs.venueData
              ),
              surfaceData: mergeStatData(
                existing.surfaceData as Record<string, { races: number; places: number }>,
                hs.surfaceData
              ),
              raceNameData: mergeStatData(
                existing.raceNameData as Record<string, { races: number; places: number }>,
                hs.raceNameData
              ),
              // 新バッチが既存より新しい場合のみ lastRace 系を上書き
              ...(hs.lastRaceDate >= (existing.lastRaceDate ?? new Date(0)) ? {
                lastRaceDate: hs.lastRaceDate,
                lastRacePopularity: hs.lastRacePopularity ?? null,
              } : {}),
              recentForm: mergeRecentForm(hs.recentForm, existing.recentForm),
            },
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces,
              totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races,
              g1Places: hs.g1Places,
              distanceData: hs.distanceData,
              venueData: hs.venueData,
              surfaceData: hs.surfaceData,
              raceNameData: hs.raceNameData,
              lastRaceDate: hs.lastRaceDate,
              lastRacePopularity: hs.lastRacePopularity ?? null,
              recentForm: hs.recentForm ?? null,
            },
          })
        }
        horsesSaved++
      } catch {
        // 個別エラーはスキップ
      }
    }

    // Claude の簡易成績を保存（Math.max でキャリア累計として扱う）
    for (const hs of claudeStats) {
      try {
        const existing = await prisma.horseStat.findUnique({ where: { horseName: hs.horseName } })
        if (existing) {
          await prisma.horseStat.update({
            where: { horseName: hs.horseName },
            data: {
              totalRaces: Math.max(existing.totalRaces, hs.totalRaces),
              totalPlaces: Math.max(existing.totalPlaces, hs.totalPlaces),
              g1Races: Math.max(existing.g1Races, hs.g1Races),
              g1Places: Math.max(existing.g1Places, hs.g1Places),
            },
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces,
              totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races,
              g1Places: hs.g1Places,
              distanceData: {},
              venueData: {},
              surfaceData: {},
            },
          })
        }
        horsesSaved++
      } catch {
        // 個別エラーはスキップ
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
      localModeThreshold: 10000,
      localModeReady: horseStatCount >= 10000,
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
      localModeThreshold: 10000,
      localModeReady: horseStatCount >= 10000,
    })
  } catch (error) {
    console.error('Learn status error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}

