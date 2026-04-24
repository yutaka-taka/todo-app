import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const search = request.nextUrl.searchParams.get('search') ?? ''
    const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') ?? '1'))
    const limit = 50

    const where = search ? { horseName: { contains: search } } : {}

    const [horses, total] = await Promise.all([
      prisma.horseStat.findMany({
        where,
        orderBy: { totalRaces: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          horseName: true,
          totalRaces: true,
          totalPlaces: true,
          g1Races: true,
          g1Places: true,
          lastRaceDate: true,
        },
      }),
      prisma.horseStat.count({ where }),
    ])

    return NextResponse.json({
      horses,
      total,
      page,
      hasMore: total > page * limit,
    })
  } catch (error) {
    console.error('Horses GET error:', error)
    return NextResponse.json({ error: '馬データ取得失敗' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()

    if (body.deleteAll === true) {
      const result = await prisma.horseStat.deleteMany({})
      return NextResponse.json({ deleted: result.count })
    }

    if (Array.isArray(body.horseNames) && body.horseNames.length > 0) {
      const result = await prisma.horseStat.deleteMany({
        where: { horseName: { in: body.horseNames as string[] } },
      })
      return NextResponse.json({ deleted: result.count })
    }

    if (typeof body.horseName === 'string' && body.horseName) {
      const result = await prisma.horseStat.deleteMany({ where: { horseName: body.horseName } })
      return NextResponse.json({ deleted: result.count })
    }

    return NextResponse.json({ error: 'パラメータが不正です' }, { status: 400 })
  } catch (error) {
    console.error('Horses DELETE error:', error)
    const message = error instanceof Error ? error.message : '削除に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
