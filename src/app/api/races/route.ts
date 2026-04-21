import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isSunday, nextSunday, startOfDay, endOfDay } from 'date-fns'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const today = new Date()
    const targetSunday = isSunday(today) ? today : nextSunday(today)

    const races = await prisma.race.findMany({
      where: {
        date: {
          gte: startOfDay(targetSunday),
          lte: endOfDay(targetSunday),
        },
        grade: 'G1',
      },
      include: {
        entries: { orderBy: { horseNumber: 'asc' } },
      },
      orderBy: { name: 'asc' },
    })

    return NextResponse.json({
      races,
      targetDate: targetSunday.toISOString(),
    })
  } catch (error) {
    console.error('Races API error:', error)
    return NextResponse.json(
      { error: 'レース情報の取得に失敗しました' },
      { status: 500 }
    )
  }
}
