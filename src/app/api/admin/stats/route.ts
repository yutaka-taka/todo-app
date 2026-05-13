import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

interface MLMeta {
  feature_cols?: string[]
  best_iteration?: number
  test_auc?: number
  test_loss?: number
  hit1_rate?: number
  hit2_rate?: number
  trained_at?: string
  n_train?: number
  n_test?: number
}

function loadMLMeta(): MLMeta | null {
  try {
    const p = path.join(process.cwd(), 'ml', 'models', 'meta.json')
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

async function computeHitRates(limit = 30) {
  const races = await prisma.race.findMany({
    where: {
      predictions: { some: {} },
      results: { some: { finishPosition: { not: null } } },
    },
    include: {
      predictions: { orderBy: { rank: 'asc' }, take: 5 },
      results: {
        where: { finishPosition: { not: null } },
        orderBy: { finishPosition: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
    take: limit,
  })

  let total = 0, hit1 = 0, hit2 = 0
  for (const race of races) {
    const top5 = race.predictions.slice(0, 5).map((p) => p.horseName)
    const actual = race.results
      .filter((r) => r.finishPosition != null && r.finishPosition <= 2)
      .map((r) => r.horseName)
    if (actual.length < 2) continue
    total++
    const hits = actual.filter((n) => top5.includes(n)).length
    if (hits >= 1) hit1++
    if (hits >= 2) hit2++
  }
  return { total, hit1, hit2 }
}

export async function GET() {
  try {
    const [raceCount, resultCount, horseCount, predCount, config, lastCalendar, lastRace] =
      await Promise.all([
        prisma.race.count(),
        prisma.raceResult.count(),
        prisma.horseStat.count(),
        prisma.prediction.count(),
        prisma.algorithmConfig.findFirst({
          where: { isActive: true },
          orderBy: { version: 'desc' },
        }),
        prisma.raceCalendar.findFirst({ orderBy: { date: 'desc' } }),
        prisma.race.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
      ])

    const { total, hit1, hit2 } = await computeHitRates(30)
    const mlMeta = loadMLMeta()

    const lastIngestion =
      lastCalendar?.lastFetched?.toISOString() ??
      lastRace?.date?.toISOString() ??
      null

    let insightsParsed: Record<string, unknown> = {}
    try {
      const raw = config?.insights
      if (raw) {
        const parsed = JSON.parse(raw as string)
        insightsParsed = Array.isArray(parsed) ? { keyFindings: parsed } : parsed
      }
    } catch { /* ok */ }

    return NextResponse.json({
      db: {
        raceCount,
        resultCount,
        horseCount,
        predCount,
        lastIngestion,
        lastRaceDate: lastRace?.date?.toISOString() ?? null,
      },
      kpi: {
        total,
        hit1,
        hit2,
        hit1Rate: total > 0 ? hit1 / total : null,
        hit2Rate: total > 0 ? hit2 / total : null,
      },
      ml: mlMeta,
      algo: config
        ? {
            version: config.version,
            accuracy: config.accuracy,
            analyzedCount: config.analyzedCount,
            updatedAt: config.updatedAt.toISOString(),
            insights: insightsParsed,
          }
        : null,
    })
  } catch (error) {
    console.error('Admin stats error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'stats fetch failed' },
      { status: 500 },
    )
  }
}
