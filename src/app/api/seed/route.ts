import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

// DBを初期化してシードデータを投入するエンドポイント
export async function POST() {
  try {
    // テーブルが存在しているか確認のため試みる
    await prisma.$queryRaw`SELECT 1`

    const raceCount = await prisma.race.count()
    const configCount = await prisma.algorithmConfig.count()

    return NextResponse.json({
      message: 'DBは初期化済みです',
      raceCount,
      configCount,
      hint: '新しいデータを追加するには db:seed コマンドを実行してください',
    })
  } catch (error) {
    console.error('Seed check error:', error)
    return NextResponse.json(
      { error: 'DB接続に失敗しました。DATABASE_URLを確認してください。' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const [raceCount, configCount, analyzedCount] = await Promise.all([
      prisma.race.count(),
      prisma.algorithmConfig.count(),
      prisma.race.count({ where: { analyzed: true } }),
    ])

    const latestConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })

    return NextResponse.json({
      status: 'ok',
      raceCount,
      configCount,
      analyzedCount,
      algorithmVersion: latestConfig?.version ?? 0,
      accuracy: latestConfig?.accuracy ?? null,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'DB接続エラー', detail: String(error) },
      { status: 500 }
    )
  }
}
