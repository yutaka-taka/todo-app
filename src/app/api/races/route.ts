import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startOfDay, endOfDay, addDays, subDays } from 'date-fns'

export const dynamic = 'force-dynamic'

// 今日を基準に「直近の土日」（土曜〜日曜）の開始日を返す
// 今日が土: 今日  今日が日: 昨日(土)  月〜金: 次の土曜
function nearestSaturday(today: Date): Date {
  const dow = today.getDay() // 0=日, 6=土
  if (dow === 6) return today
  if (dow === 0) return subDays(today, 1)
  return addDays(today, 6 - dow) // 月(1)→+5, 火(2)→+4 ... 金(5)→+1
}

export async function GET() {
  try {
    const today = new Date()
    const saturday = startOfDay(nearestSaturday(today))
    const sunday = endOfDay(addDays(saturday, 1))

    const races = await prisma.race.findMany({
      where: {
        date: { gte: saturday, lte: sunday },
        grade: { in: ['G1', 'G2'] },
      },
      include: {
        entries: { orderBy: { horseNumber: 'asc' } },
      },
      orderBy: [{ date: 'asc' }, { grade: 'asc' }, { name: 'asc' }],
    })

    return NextResponse.json({
      races,
      targetDate: saturday.toISOString(),
    })
  } catch (error) {
    console.error('Races API error:', error)
    return NextResponse.json(
      { error: 'レース情報の取得に失敗しました' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, date, venue, grade, surface, distance } = body

    if (!name || !date || !venue || !grade || !surface || !distance) {
      return NextResponse.json({ error: '必須項目が不足しています' }, { status: 400 })
    }

    const raceDate = new Date(date)
    if (isNaN(raceDate.getTime())) {
      return NextResponse.json({ error: '日付の形式が正しくありません' }, { status: 400 })
    }

    // 同名・同年のレースが既にあれば日付等を更新
    const year = raceDate.getFullYear()
    const existing = await prisma.race.findFirst({
      where: {
        name,
        date: {
          gte: new Date(`${year}-01-01`),
          lt: new Date(`${year + 1}-01-01`),
        },
      },
    })

    if (existing) {
      const updated = await prisma.race.update({
        where: { id: existing.id },
        data: { date: raceDate, venue, grade, surface, distance: Number(distance) },
      })
      return NextResponse.json({ race: updated, action: 'updated' })
    }

    const race = await prisma.race.create({
      data: { name, date: raceDate, venue, grade, surface, distance: Number(distance) },
    })
    return NextResponse.json({ race, action: 'created' })
  } catch (error) {
    console.error('Race POST error:', error)
    return NextResponse.json({ error: 'レースの登録に失敗しました' }, { status: 500 })
  }
}
