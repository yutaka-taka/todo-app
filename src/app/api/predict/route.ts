import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generatePrediction } from '@/lib/ai'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const { raceId } = await request.json()

    if (!raceId) {
      return NextResponse.json({ error: 'raceIdが必要です' }, { status: 400 })
    }

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: {
        entries: { orderBy: { horseNumber: 'asc' } },
      },
    })

    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })
    }

    // 現在有効なアルゴリズム設定を取得
    const algorithmConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })

    const rules = algorithmConfig?.rules ?? '基本的な連対率予測を行います。'

    const raceDate = format(new Date(race.date), 'yyyy年M月d日(E)', { locale: ja })

    // Claude AIで予測生成
    const result = await generatePrediction({
      raceName: race.name,
      raceDate,
      venue: race.venue,
      surface: race.surface,
      distance: race.distance,
      grade: race.grade,
      entries: race.entries.map((e) => ({
        horseNumber: e.horseNumber,
        horseName: e.horseName,
        jockey: e.jockey,
        age: e.age,
        sex: e.sex,
        weight: e.weight,
      })),
      algorithmRules: rules,
    })

    // 既存の予想を削除して新しい予想を保存
    await prisma.prediction.deleteMany({ where: { raceId } })

    await prisma.prediction.createMany({
      data: result.predictions.map((p) => ({
        raceId,
        horseNumber: p.horseNumber,
        horseName: p.horseName,
        placeRate: p.placeRate,
        rank: p.rank,
        factors: p.factors ? (p.factors as Record<string, string>) : undefined,
      })),
    })

    return NextResponse.json({
      predictions: result.predictions,
      analysis: result.analysis,
      race: {
        name: race.name,
        venue: race.venue,
        surface: race.surface,
        distance: race.distance,
        date: race.date,
      },
    })
  } catch (error) {
    console.error('Predict API error:', error)
    const message = error instanceof Error ? error.message : '予測の生成に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
