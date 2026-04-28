import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { findNetkeibaRaceId } from '@/lib/netkeibaRaceId'

export const maxDuration = 120

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

function decodeEucJp(buffer: ArrayBuffer): string {
  try { return new TextDecoder('euc-jp').decode(buffer) }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
}

// shutubaページから 馬名→horse_id のマップを取得
async function fetchHorseIds(netkeibaRaceId: string): Promise<Record<string, string>> {
  const res = await fetch(
    `https://race.netkeiba.com/race/shutuba.html?race_id=${netkeibaRaceId}`,
    { headers: HEADERS },
  )
  if (!res.ok) return {}
  const html = decodeEucJp(await res.arrayBuffer())

  const result: Record<string, string> = {}
  // 馬名リンク: <a href="/horse/2021105678/">馬名</a>
  const pattern = /href="\/horse\/(\d+)\/"[^>]*>([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(html)) !== null) {
    const horseId = m[1]
    const name = m[2].trim()
    if (name && horseId) result[name] = horseId
  }
  return result
}

// netkeiba馬詳細ページから血統を取得
async function fetchPedigree(horseId: string): Promise<{
  sire: string | null
  dam: string | null
  sireOfSire: string | null
  damOfSire: string | null
  sireOfDam: string | null
  damOfDam: string | null
} | null> {
  try {
    const res = await fetch(
      `https://db.netkeiba.com/horse/${horseId}/`,
      { headers: HEADERS },
    )
    if (!res.ok) return null
    const html = decodeEucJp(await res.arrayBuffer())

    // blood_tableから父・母・2世代祖先（4頭）を抽出
    const tableM = html.match(/<table[^>]*class="[^"]*blood_table[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
    if (!tableM) return null
    const tableHtml = tableM[1]

    // rowspan="8" → 父(idx=0) / 母(idx=1)
    // rowspan="4" → 父父(idx=0) / 父母(idx=1) / 母父(idx=2) / 母母(idx=3)
    const rowspan8 = Array.from(tableHtml.matchAll(/<td[^>]*rowspan="8"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/g))
      .map(m2 => m2[1].trim())
    const rowspan4 = Array.from(tableHtml.matchAll(/<td[^>]*rowspan="4"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/g))
      .map(m2 => m2[1].trim())

    return {
      sire:       rowspan8[0] ?? null,
      dam:        rowspan8[1] ?? null,
      sireOfSire: rowspan4[0] ?? null,  // 父父
      damOfSire:  rowspan4[1] ?? null,  // 父母
      sireOfDam:  rowspan4[2] ?? null,  // 母父
      damOfDam:   rowspan4[3] ?? null,  // 母母
    }
  } catch {
    return null
  }
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
      return NextResponse.json({ error: '出走馬が未登録です。先に出走馬を登録してください。' }, { status: 400 })
    }

    const netkeibaRaceId = await findNetkeibaRaceId(race.venue, new Date(race.date))
    if (!netkeibaRaceId) {
      return NextResponse.json({ error: 'netkeiba レースIDが見つかりません。レース当日以降に再試行してください。' }, { status: 404 })
    }

    const horseIds = await fetchHorseIds(netkeibaRaceId)
    await delay(400)

    const results: Array<{ name: string; sire: string | null; dam: string | null; sireOfSire: string | null; damOfSire: string | null; sireOfDam: string | null; damOfDam: string | null }> = []
    let updated = 0

    for (const entry of race.entries) {
      const horseId = horseIds[entry.horseName]
      if (!horseId) continue

      const pedigree = await fetchPedigree(horseId)
      await delay(500)
      if (!pedigree) continue

      try {
        await prisma.horseStat.upsert({
          where: { horseName: entry.horseName },
          update: {
            sire:       pedigree.sire,
            dam:        pedigree.dam,
            sireOfSire: pedigree.sireOfSire,
            damOfSire:  pedigree.damOfSire,
            sireOfDam:  pedigree.sireOfDam,
            damOfDam:   pedigree.damOfDam,
          },
          create: {
            horseName:    entry.horseName,
            totalRaces:   0,
            totalPlaces:  0,
            sire:         pedigree.sire,
            dam:          pedigree.dam,
            sireOfSire:   pedigree.sireOfSire,
            damOfSire:    pedigree.damOfSire,
            sireOfDam:    pedigree.sireOfDam,
            damOfDam:     pedigree.damOfDam,
          },
        })
        updated++
        results.push({
          name: entry.horseName,
          sire: pedigree.sire,
          dam:  pedigree.dam,
          sireOfSire: pedigree.sireOfSire,
          damOfSire:  pedigree.damOfSire,
          sireOfDam:  pedigree.sireOfDam,
          damOfDam:   pedigree.damOfDam,
        })
      } catch { /* skip */ }
    }

    return NextResponse.json({
      updated,
      horses: results,
      message: `${updated}頭の血統データを取得しました`,
    })
  } catch (error) {
    console.error('fetch-pedigree error:', error)
    return NextResponse.json({ error: '血統取得に失敗しました' }, { status: 500 })
  }
}
