import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { format } from 'date-fns'
import { addDays, subDays, startOfDay, endOfDay } from 'date-fns'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

// EUC-JP ページを正しくデコード
async function fetchEucJp(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    try {
      return new TextDecoder('euc-jp').decode(buffer)
    } catch {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    }
  } catch {
    return null
  }
}

// UTF-8 ページを取得
async function fetchUtf8(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// ---- race_id 取得 ----

const VENUE_CODES: Record<string, string> = {
  '札幌': '01', '函館': '02', '福島': '03', '新潟': '04',
  '東京': '05', '中山': '06', '中京': '07', '京都': '08',
  '阪神': '09', '小倉': '10',
}

function nearestSaturday(d: Date): Date {
  const dow = d.getDay()
  if (dow === 6) return d
  if (dow === 0) return subDays(d, 1)
  return addDays(d, 6 - dow)
}

// SP スケジュールページから venue + 土曜/日曜 で race_id を特定（今週末用）
async function findRaceIdFromSchedule(
  raceDateStr: string,   // YYYYMMDD
  venue: string,
  isSaturday: boolean,
): Promise<string | null> {
  const venueCode = VENUE_CODES[venue]
  if (!venueCode) return null

  const html = await fetchUtf8(
    `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${raceDateStr}`,
  )
  if (!html) return null

  const seen = new Set<string>()
  const candidates: Array<{ raceId: string; dayNum: number; raceNum: number }> = []

  const pattern = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
  let m
  while ((m = pattern.exec(html)) !== null) {
    const raceId = m[1] + m[2] + m[3] + m[4] + m[5]
    if (seen.has(raceId) || m[2] !== venueCode) continue
    seen.add(raceId)
    candidates.push({ raceId, dayNum: parseInt(m[4]), raceNum: parseInt(m[5]) })
  }

  if (candidates.length === 0) return null

  // R11 と R12 のみ対象（重賞は最終レース帯）
  const r11 = candidates.filter((c) => c.raceNum === 11 || c.raceNum === 12)
  if (r11.length === 0) return null

  r11.sort((a, b) => a.dayNum - b.dayNum)
  const minDay = r11[0].dayNum

  if (isSaturday) {
    return r11.find((c) => c.dayNum === minDay && c.raceNum === 11)?.raceId
      ?? r11.find((c) => c.dayNum === minDay)?.raceId
      ?? null
  } else {
    const sunDay = minDay + 1
    return r11.find((c) => c.dayNum === sunDay && c.raceNum === 11)?.raceId
      ?? r11.find((c) => c.dayNum === sunDay)?.raceId
      ?? null
  }
}

// db.netkeiba.com 検索で race_id を取得（過去レース用、EUC-JP）
async function findRaceIdFromSearch(cleanName: string, year: number): Promise<string | null> {
  const url = `https://db.netkeiba.com/?pid=race_list&word=${encodeURIComponent(cleanName)}&start_year=${year}&end_year=${year}&list=20`
  const html = await fetchEucJp(url)
  if (!html) return null

  // /race/XXXXXXXXXXXX/ 形式のリンクを抽出
  const m = html.match(/href="\/race\/(\d{10,12})\/?"/)
  return m ? m[1] : null
}

// ---- 結果パース ----

// race.netkeiba.com/race/result.html ページ（EUC-JP）から 1着・2着を取得
function parseResultPage(html: string): { first: string; second: string } | null {
  const entries: { rank: number; name: string }[] = []

  const rowPattern = /<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi

  for (const row of Array.from(html.matchAll(rowPattern))) {
    const r = row[1]

    // 着順: <div class="Rank">1</div>
    const rankM = r.match(/<div[^>]*class="Rank"[^>]*>(\d{1,2})<\/div>/)
    if (!rankM) continue
    const rank = parseInt(rankM[1])
    if (rank < 1 || rank > 18) continue

    // 馬名: /horse/ リンクの title 属性（EUC-JPデコード済みなので正常な日本語）
    const nameM = r.match(/\/horse\/\d+[^>]+title="([^"]+)"/)
      ?? r.match(/<span[^>]*class="HorseNameSpan"[^>]*>([^<]+)<\/span>/)
    if (!nameM) continue
    const name = nameM[1].trim()
    if (!name || name.length < 2) continue

    entries.push({ rank, name })
  }

  entries.sort((a, b) => a.rank - b.rank)
  const first = entries.find((e) => e.rank === 1)?.name
  const second = entries.find((e) => e.rank === 2)?.name
  if (!first || !second) return null

  return { first, second }
}

// race.netkeiba.com の結果を取得（EUC-JP対応）
async function fetchResultByRaceId(raceId: string): Promise<{ first: string; second: string } | null> {
  const html = await fetchEucJp(
    `https://race.netkeiba.com/race/result.html?race_id=${raceId}`,
  )
  if (!html) return null
  return parseResultPage(html)
}

// ---- メインハンドラ ----

export async function POST(request: NextRequest) {
  try {
    const { raceId } = await request.json()
    if (!raceId) return NextResponse.json({ error: 'raceIdが必要です' }, { status: 400 })

    const race = await prisma.race.findUnique({ where: { id: raceId } })
    if (!race) return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })

    const now = new Date()
    if (race.date > now) {
      return NextResponse.json({ error: 'レースはまだ開催されていません' }, { status: 400 })
    }

    const raceDate = new Date(race.date)
    const cleanName = race.name.replace(/\s*\d{4}\s*$/, '').trim()
    const year = raceDate.getFullYear()

    // --- 方法1: 今週末 SP スケジュールページから race_id を取得 ---
    const saturday = startOfDay(nearestSaturday(raceDate))
    const sunday = endOfDay(addDays(saturday, 1))
    const isThisWeekend = raceDate >= saturday && raceDate <= sunday
    const isSat = raceDate.getDay() === 6

    if (isThisWeekend) {
      const satStr = format(saturday, 'yyyyMMdd')
      const netkeibaRaceId = await findRaceIdFromSchedule(satStr, race.venue, isSat)
      if (netkeibaRaceId) {
        const result = await fetchResultByRaceId(netkeibaRaceId)
        if (result) return NextResponse.json({ ...result, source: 'netkeiba' })
      }
    }

    // --- 方法2: db.netkeiba.com 検索で race_id を取得（過去レース対応） ---
    const searchedId = await findRaceIdFromSearch(cleanName, year)
    if (searchedId) {
      const result = await fetchResultByRaceId(searchedId)
      if (result) return NextResponse.json({ ...result, source: 'netkeiba_search' })
    }

    // --- 方法3: race_id を推定して直接試行（前後の週も）---
    // SP ページで今週以外の開催週も探索
    for (let offset = -1; offset <= 1; offset++) {
      if (offset === 0 && isThisWeekend) continue  // 方法1で試済み
      const tryDate = addDays(saturday, offset * 7)
      const satStr = format(nearestSaturday(tryDate), 'yyyyMMdd')
      const netkeibaRaceId = await findRaceIdFromSchedule(satStr, race.venue, isSat)
      if (netkeibaRaceId) {
        const result = await fetchResultByRaceId(netkeibaRaceId)
        if (result) return NextResponse.json({ ...result, source: 'netkeiba' })
      }
    }

    return NextResponse.json(
      { error: `「${cleanName}」の結果をネットから取得できませんでした。手動で入力してください。` },
      { status: 404 },
    )
  } catch (error) {
    console.error('Fetch race result error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
