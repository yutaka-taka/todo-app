import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const race = await prisma.race.findUnique({
      where: { id: params.id },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
    })
    if (!race) {
      return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })
    }
    return NextResponse.json({ race })
  } catch (error) {
    console.error('race GET error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
