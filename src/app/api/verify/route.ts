import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { refreshUpcomingRaceHorses } from '@/lib/ai'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

export async function POST() {
  try {
    const today = new Date()
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY

    if (!hasApiKey) {
      return NextResponse.json({ error: 'Claude APIキーが設定されていないため再検証できません' }, { status: 400 })
    }

    const upcomingRace = await prisma.race.findFirst({
      where: { date: { gte: today }, grade: { in: ['G1', 'G2', 'G3'] } },
      orderBy: { date: 'asc' },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
    })

    if (!upcomingRace) {
      return NextResponse.json({ error: '直近の重賞レースが見つかりません' }, { status: 404 })
    }

    if (upcomingRace.entries.length === 0) {
      return NextResponse.json({
        verified: 0,
        raceName: upcomingRace.name,
        raceDate: format(new Date(upcomingRace.date), 'M月d日(E)', { locale: ja }),
        message: 'まだ出走馬が確定していません。出走前日の10:00以降にお試しください。',
      })
    }

    const horseNames = upcomingRace.entries.map((e) => e.horseName)
    const raceDate = format(new Date(upcomingRace.date), 'yyyy年M月d日', { locale: ja })

    const upcomingStats = await refreshUpcomingRaceHorses({
      raceName: upcomingRace.name,
      venue: upcomingRace.venue,
      surface: upcomingRace.surface,
      distance: upcomingRace.distance,
      grade: upcomingRace.grade,
      raceDate,
      horseNames,
    })

    let verified = 0
    const verifiedHorses: string[] = []

    for (const hs of upcomingStats) {
      if (!hs.horseName?.trim()) continue
      try {
        const existing = await prisma.horseStat.findUnique({ where: { horseName: hs.horseName } })
        if (existing) {
          await prisma.horseStat.update({
            where: { horseName: hs.horseName },
            data: {
              totalRaces: Math.max(existing.totalRaces, hs.totalRaces || 0),
              totalPlaces: Math.max(existing.totalPlaces, hs.totalPlaces || 0),
              g1Races: Math.max(existing.g1Races, hs.g1Races || 0),
              g1Places: Math.max(existing.g1Places, hs.g1Places || 0),
              recentForm: hs.recentForm || existing.recentForm,
            },
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces || 0,
              totalPlaces: hs.totalPlaces || 0,
              g1Races: hs.g1Races || 0,
              g1Places: hs.g1Places || 0,
              recentForm: hs.recentForm || null,
              distanceData: {},
              venueData: {},
              surfaceData: {},
            },
          })
        }
        verifiedHorses.push(hs.horseName)
        verified++
      } catch { /* 個別エラーはスキップ */ }
    }

    return NextResponse.json({
      verified,
      raceName: upcomingRace.name,
      raceDate: format(new Date(upcomingRace.date), 'M月d日(E)', { locale: ja }),
      verifiedHorses,
      totalEntries: horseNames.length,
      message: `${upcomingRace.name}（${raceDate}）の出走馬${verified}頭の情報を最新化しました。`,
    })
  } catch (error) {
    console.error('Verify API error:', error)
    const message = error instanceof Error ? error.message : '再検証に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  try {
    const today = new Date()
    const upcomingRace = await prisma.race.findFirst({
      where: { date: { gte: today }, grade: { in: ['G1', 'G2', 'G3'] } },
      orderBy: { date: 'asc' },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
    })

    if (!upcomingRace) {
      return NextResponse.json({ raceName: null, entryCount: 0 })
    }

    return NextResponse.json({
      raceName: upcomingRace.name,
      raceDate: format(new Date(upcomingRace.date), 'M月d日(E)', { locale: ja }),
      entryCount: upcomingRace.entries.length,
      hasEntries: upcomingRace.entries.length > 0,
    })
  } catch (error) {
    console.error('Verify GET error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}
