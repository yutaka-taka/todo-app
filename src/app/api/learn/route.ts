import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { analyzeRacesForLearning } from '@/lib/ai'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

const BATCH_SIZE = 3 // 1回の学習で分析するレース数

export async function POST() {
  try {
    const today = new Date()

    // 未分析の過去重賞レースを取得（直近順）
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
      const totalAnalyzed = await prisma.race.count({
        where: { analyzed: true }
      })
      return NextResponse.json({
        analyzed: 0,
        totalAnalyzed,
        message: '分析が済んでいない重賞レースはありません。新しいレース結果が追加されるとまた学習できます。',
        summary: '全レース分析済みです。',
      })
    }

    // 現在のアルゴリズム設定を取得
    const currentConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })

    const currentRules = currentConfig?.rules ?? '初期設定'
    const currentVersion = currentConfig?.version ?? 0

    // レースデータをテキストに変換
    const racesData = unanalyzedRaces
      .map((race) => {
        const dateStr = format(new Date(race.date), 'yyyy年M月d日', { locale: ja })
        const resultsText =
          race.results.length > 0
            ? race.results
                .slice(0, 5)
                .map(
                  (r) =>
                    `  ${r.finishPosition}着: ${r.horseName}${r.jockey ? ` (${r.jockey})` : ''}${r.popularity ? ` ${r.popularity}番人気` : ''}${r.odds ? ` ${r.odds}倍` : ''}`
                )
                .join('\n')
            : '  ※結果データなし（AIが知識から分析）'

        const entriesText =
          race.entries.length > 0
            ? `出走馬: ${race.entries.map((e) => `${e.horseNumber}番${e.horseName}`).join(', ')}`
            : ''

        return `---
レース名: ${race.name}
開催日: ${dateStr}
競馬場: ${race.venue} ${race.surface}${race.distance}m ${race.grade}
${entriesText}
着順結果:
${resultsText}`
      })
      .join('\n\n')

    // Claude AIで学習
    const learningResult = await analyzeRacesForLearning({
      racesData,
      currentRules,
    })

    // 新バージョンのアルゴリズム設定を作成
    const newVersion = currentVersion + 1

    // 既存のactiveを無効化
    await prisma.algorithmConfig.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    })

    // 新しい設定を保存
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

    // 分析ログを保存してレースを分析済みに更新
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

      await prisma.race.update({
        where: { id: race.id },
        data: { analyzed: true },
      })
    }

    // 残りの未分析レース数
    const remainingCount = await prisma.race.count({
      where: {
        date: { lt: today },
        analyzed: false,
        grade: { in: ['G1', 'G2', 'G3'] },
      },
    })

    const totalAnalyzed = await prisma.race.count({
      where: { analyzed: true }
    })

    return NextResponse.json({
      analyzed: unanalyzedRaces.length,
      totalAnalyzed,
      remaining: remainingCount,
      newVersion,
      estimatedAccuracy: learningResult.estimatedAccuracy,
      summary: learningResult.summary,
      keyPatterns: learningResult.keyPatterns,
      newInsightsCount: learningResult.newInsights.length,
      raceNames: unanalyzedRaces.map((r) => r.name),
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
      where: {
        date: { lt: today },
        grade: { in: ['G1', 'G2', 'G3'] },
      },
    })

    const analyzedRaces = await prisma.race.count({
      where: {
        date: { lt: today },
        analyzed: true,
        grade: { in: ['G1', 'G2', 'G3'] },
      },
    })

    const unanalyzedRaces = await prisma.race.count({
      where: {
        date: { lt: today },
        analyzed: false,
        grade: { in: ['G1', 'G2', 'G3'] },
      },
    })

    return NextResponse.json({
      version: config?.version ?? 0,
      analyzedCount: config?.analyzedCount ?? 0,
      accuracy: config?.accuracy,
      totalRaces,
      analyzedRaces,
      unanalyzedRaces,
      hasInsights: !!config?.insights,
    })
  } catch (error) {
    console.error('Learn status error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}
