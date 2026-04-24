import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const maxDuration = 30

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
  'Cache-Control': 'no-cache',
}

// レース名から年号を除去して検索用キーワードを作成
function cleanRaceName(name: string): string {
  return name.replace(/\s*\d{4}\s*$/, '').trim()
}

// netkeiba DB でレース検索 → 結果ページURLを取得
async function findRaceUrl(cleanName: string, year: number): Promise<string | null> {
  const encoded = encodeURIComponent(cleanName)
  const searchUrl = `https://db.netkeiba.com/?pid=race_list&word=${encoded}&start_year=${year}&end_year=${year}&list=20`

  try {
    const res = await fetch(searchUrl, { headers: HEADERS })
    if (!res.ok) return null
    const html = await res.text()

    // /race/XXXXXXXXXXXX/ 形式のリンクを抽出
    const matches = Array.from(html.matchAll(/href="(\/race\/\d{10,12}\/?)"/g))
    const seen = new Set<string>()
    const ids = matches.map((m) => m[1]).filter((id) => { if (seen.has(id)) return false; seen.add(id); return true })
    if (ids.length === 0) return null

    return `https://db.netkeiba.com${ids[0]}`
  } catch {
    return null
  }
}

// レース結果ページをパースして1着・2着馬名を取得
function parseResults(html: string): { first: string; second: string } | null {
  // netkeiba DB の結果テーブル: <table class="race_table_01 nk_tb_common">
  const tableMatch = html.match(/<table[^>]*class="[^"]*race_table_01[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableMatch) return null

  const tableHtml = tableMatch[1]
  const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))

  const results: { rank: number; name: string }[] = []

  for (const row of rows) {
    const rowHtml = row[1]

    // 着順セル（先頭の数字のみのTD）
    const rankMatch = rowHtml.match(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/)
    if (!rankMatch) continue
    const rank = parseInt(rankMatch[1], 10)
    if (rank < 1 || rank > 18) continue

    // 馬名 (/horse/ リンクのテキスト)
    const nameMatch = rowHtml.match(/href="\/horse\/[^"]+?"[^>]*>([^<]{2,12})<\/a>/)
    if (!nameMatch) continue

    const name = nameMatch[1].trim()
    if (name && name.length >= 2) {
      results.push({ rank, name })
    }
  }

  results.sort((a, b) => a.rank - b.rank)
  if (results.length < 2) return null

  const first = results.find((r) => r.rank === 1)?.name
  const second = results.find((r) => r.rank === 2)?.name
  if (!first || !second) return null

  return { first, second }
}

// Yahoo!競馬からも試みる（netkeiba失敗時の代替）
async function fetchFromYahooKeiba(raceName: string, raceDate: Date): Promise<{ first: string; second: string } | null> {
  try {
    const cleanName = cleanRaceName(raceName)
    const year = raceDate.getFullYear()
    const searchUrl = `https://keiba.yahoo.co.jp/search/?word=${encodeURIComponent(cleanName + year)}&type=race`
    const res = await fetch(searchUrl, { headers: HEADERS })
    if (!res.ok) return null
    const html = await res.text()

    // Yahoo競馬の結果ページリンクを探す
    const linkMatch = html.match(/href="(\/race\/result\/[^"]+)"/)
    if (!linkMatch) return null

    const resultRes = await fetch(`https://keiba.yahoo.co.jp${linkMatch[1]}`, { headers: HEADERS })
    if (!resultRes.ok) return null
    const resultHtml = await resultRes.text()

    // Yahoo競馬の結果テーブル: <td class="resultNum">1</td>
    const rows = Array.from(resultHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
    const results: { rank: number; name: string }[] = []

    for (const row of rows) {
      const rowHtml = row[1]
      const rankMatch = rowHtml.match(/class="[^"]*resultNum[^"]*"[^>]*>\s*(\d{1,2})\s*<\/td>/)
      if (!rankMatch) continue
      const rank = parseInt(rankMatch[1], 10)
      if (rank < 1 || rank > 18) continue

      const nameMatch = rowHtml.match(/class="[^"]*horseName[^"]*"[^>]*>([^<]{2,12})<\//)
      if (!nameMatch) continue

      results.push({ rank, name: nameMatch[1].trim() })
    }

    results.sort((a, b) => a.rank - b.rank)
    if (results.length < 2) return null

    const first = results.find((r) => r.rank === 1)?.name
    const second = results.find((r) => r.rank === 2)?.name
    if (!first || !second) return null
    return { first, second }
  } catch {
    return null
  }
}

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

    const cleanName = cleanRaceName(race.name)
    const year = race.date.getFullYear()

    // 1. netkeiba DBで検索
    const raceUrl = await findRaceUrl(cleanName, year)

    if (raceUrl) {
      try {
        const res = await fetch(raceUrl, { headers: HEADERS })
        if (res.ok) {
          const html = await res.text()
          const result = parseResults(html)
          if (result) {
            return NextResponse.json({ ...result, source: 'netkeiba' })
          }
        }
      } catch { /* 次のソースへ */ }
    }

    // 2. Yahoo!競馬で代替取得
    const yahooResult = await fetchFromYahooKeiba(race.name, race.date)
    if (yahooResult) {
      return NextResponse.json({ ...yahooResult, source: 'yahoo' })
    }

    return NextResponse.json(
      { error: `「${race.name}」の結果をネットから取得できませんでした。手動で入力してください。` },
      { status: 404 }
    )
  } catch (error) {
    console.error('Fetch race result error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
