import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { findNetkeibaRaceId } from '@/lib/netkeibaRaceId'

export const maxDuration = 60

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

// shutuba ページから 馬番→{体重,増減} を取得
async function scrapeWeights(netkeibaRaceId: string): Promise<Record<number, { weight: number; weightChange: number }>> {
  const res = await fetch(
    `https://race.netkeiba.com/race/shutuba.html?race_id=${netkeibaRaceId}`,
    { headers: HEADERS },
  )
  if (!res.ok) return {}

  const buffer = await res.arrayBuffer()
  let html: string
  try { html = new TextDecoder('euc-jp').decode(buffer) }
  catch { html = new TextDecoder('utf-8', { fatal: false }).decode(buffer) }

  const result: Record<number, { weight: number; weightChange: number }> = {}

  const rowPattern = /<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi
  for (const row of Array.from(html.matchAll(rowPattern))) {
    const r = row[1]

    // 馬番
    const umabanM = r.match(/class="Umaban\d+[^"]*"[^>]*>(\d{1,2})</)
    if (!umabanM) continue
    const horseNumber = parseInt(umabanM[1])
    if (horseNumber < 1 || horseNumber > 18) continue

    // 馬体重: <td class="Weight"> 468<small>(-12)</small> </td>
    const weightM = r.match(/class="Weight"[^>]*>\s*(\d{3,4})\s*<small>\(([+\-]?\d+)\)<\/small>/)
    if (!weightM) continue
    const weight = parseInt(weightM[1])
    const weightChange = parseInt(weightM[2])

    if (weight >= 300 && weight <= 700) {
      result[horseNumber] = { weight, weightChange }
    }
  }

  return result
}

export async function POST(request: NextRequest) {
  try {
    const { raceId } = await request.json()
    if (!raceId) return NextResponse.json({ error: 'raceIdが必要です' }, { status: 400 })

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
    })
    if (!race) return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })
    if (race.entries.length === 0) {
      return NextResponse.json(
        { error: '出走馬が未登録です。先に「↻ 週末レース 出走馬を再検証」を実行してください。' },
        { status: 400 },
      )
    }

    const netkeibaRaceId = await findNetkeibaRaceId(race.venue, new Date(race.date))
    if (!netkeibaRaceId) {
      return NextResponse.json(
        { error: 'netkeiba のレースIDが見つかりませんでした。レース当日の朝以降に再試行してください。' },
        { status: 404 },
      )
    }

    const weightsByNumber = await scrapeWeights(netkeibaRaceId)

    const results: Record<string, { weight: number | null; weightChange: number | null }> = {}
    let fetchedCount = 0
    for (const entry of race.entries) {
      const w = weightsByNumber[entry.horseNumber]
      if (w) {
        results[entry.horseName] = w
        fetchedCount++
      } else {
        results[entry.horseName] = { weight: null, weightChange: null }
      }
    }

    return NextResponse.json({
      results,
      fetchedCount,
      totalCount: race.entries.length,
      message: fetchedCount > 0
        ? `${race.name}: ${race.entries.length}頭中 ${fetchedCount}頭の馬体重を取得しました`
        : '馬体重データがありません。当日発表前の可能性があります。',
    })
  } catch (error) {
    console.error('fetch-weights error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
