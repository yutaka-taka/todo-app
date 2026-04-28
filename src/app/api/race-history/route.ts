import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const grade  = searchParams.get('grade') ?? 'all'
    const year   = parseInt(searchParams.get('year') ?? '0') || 0
    const page   = Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1)
    const limit  = 30

    const where: Record<string, unknown> = {
      grade: grade === 'all' ? { in: ['G1', 'G2'] } : grade,
    }
    if (year > 0) {
      where.date = {
        gte: new Date(`${year}-01-01`),
        lt:  new Date(`${year + 1}-01-01`),
      }
    }

    const [total, races] = await Promise.all([
      prisma.race.count({ where }),
      prisma.race.findMany({
        where,
        orderBy: [{ date: 'desc' }, { grade: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          date: true,
          venue: true,
          grade: true,
          surface: true,
          distance: true,
          analyzed: true,
          _count: { select: { entries: true, results: true } },
        },
      }),
    ])

    // 利用可能な年一覧
    const yearRows = await prisma.$queryRaw<Array<{ yr: number }>>`
      SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS yr
      FROM "Race"
      WHERE grade IN ('G1','G2')
      ORDER BY yr DESC
    `
    const years = yearRows.map((r) => r.yr)

    // グレード別集計
    const g1Count = await prisma.race.count({ where: { grade: 'G1' } })
    const g2Count = await prisma.race.count({ where: { grade: 'G2' } })

    const formatted = races.map((r) => ({
      id:          r.id,
      name:        r.name,
      date:        r.date.toISOString().slice(0, 10),
      venue:       r.venue,
      grade:       r.grade,
      surface:     r.surface,
      distance:    r.distance,
      analyzed:    r.analyzed,
      entryCount:  r._count.entries,
      resultCount: r._count.results,
    }))

    return NextResponse.json({
      races: formatted,
      total,
      page,
      hasMore: page * limit < total,
      years,
      stats: { g1: g1Count, g2: g2Count, total: g1Count + g2Count },
    })
  } catch (error) {
    console.error('race-history GET error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
