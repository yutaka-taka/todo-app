import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { subMonths } from 'date-fns'

export const dynamic = 'force-dynamic'

// 12ヶ月以上レースに出ていない馬を引退候補とみなす
const RETIRED_THRESHOLD_MONTHS = 12
const MIN_RACES = 3

export async function GET() {
  try {
    const threshold = subMonths(new Date(), RETIRED_THRESHOLD_MONTHS)

    const horses = await prisma.horseStat.findMany({
      where: {
        lastRaceDate: { lt: threshold, not: null },
        totalRaces: { gte: MIN_RACES },
      },
      orderBy: { lastRaceDate: 'asc' },
      select: {
        horseName: true,
        totalRaces: true,
        totalPlaces: true,
        g1Races: true,
        g1Places: true,
        lastRaceDate: true,
      },
    })

    return NextResponse.json({ horses, count: horses.length })
  } catch (error) {
    console.error('retired GET error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { names }: { names: string[] } = await request.json()
    if (!Array.isArray(names) || names.length === 0) {
      return NextResponse.json({ error: '削除する馬名リストが必要です' }, { status: 400 })
    }

    const result = await prisma.horseStat.deleteMany({
      where: { horseName: { in: names } },
    })

    return NextResponse.json({ deleted: result.count, message: `${result.count}頭のデータを削除しました` })
  } catch (error) {
    console.error('retired DELETE error:', error)
    return NextResponse.json({ error: '削除に失敗しました' }, { status: 500 })
  }
}
