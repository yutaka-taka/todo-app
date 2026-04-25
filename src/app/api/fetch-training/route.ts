import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const maxDuration = 60

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
  'Cache-Control': 'no-cache',
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// netkeiba で馬名検索 → horse_id を返す
async function findHorseId(horseName: string): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(horseName)
    const res = await fetch(`https://db.netkeiba.com/?pid=horse_list&word=${encoded}`, { headers: HEADERS })
    if (!res.ok) return null
    const html = await res.text()
    const match = html.match(/href="\/horse\/(\d{10,12})\/?"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// 馬の戦績ページから直近レースの上がり3F・通過順を取得
async function fetchHorseRaceStats(horseId: string): Promise<{
  lastThreeFurlong: number | null
  frontPositions: number[]
}> {
  try {
    const res = await fetch(`https://db.netkeiba.com/horse/${horseId}/`, { headers: HEADERS })
    if (!res.ok) return { lastThreeFurlong: null, frontPositions: [] }
    const html = await res.text()

    // 戦績テーブルを抽出
    const tableMatch = html.match(/<table[^>]*class="[^"]*db_h_race_results[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
    if (!tableMatch) return { lastThreeFurlong: null, frontPositions: [] }

    const rows = Array.from(tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
    let lastThreeFurlong: number | null = null
    const frontPositions: number[] = []

    for (const row of rows) {
      // 各セルのテキストを取得
      const tds = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      if (tds.length < 8) continue
      const texts = tds.map((td) => td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())

      // 上がり3F を探す: "33.5" や "34.2" のような小数値 (25.0〜45.0)
      if (lastThreeFurlong === null) {
        for (const text of texts) {
          const m = text.match(/^(\d{2}\.\d)$/)
          if (m) {
            const val = parseFloat(m[1])
            if (val >= 25 && val <= 45) {
              lastThreeFurlong = val
              break
            }
          }
        }
      }

      // 通過順位 を探す: "3-3-4-4" や "1-1-1" のような形式
      for (const text of texts) {
        const m = text.match(/^(\d{1,2})-(\d{1,2})/)
        if (m) {
          const pos = parseInt(m[1])
          if (pos >= 1 && pos <= 18) {
            frontPositions.push(pos)
          }
          break
        }
      }

      // 直近5レース分取得したら終了
      if (lastThreeFurlong !== null && frontPositions.length >= 5) break
    }

    return { lastThreeFurlong, frontPositions }
  } catch {
    return { lastThreeFurlong: null, frontPositions: [] }
  }
}

// 通過順位の平均から脚質を推定
function inferRunningStyle(frontPositions: number[]): string | null {
  if (frontPositions.length < 2) return null
  const recent = frontPositions.slice(0, 5)
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length
  if (avg <= 1.8) return '逃'
  if (avg <= 4.0) return '先'
  if (avg <= 8.0) return '差'
  return '追'
}

// 1頭分のデータを取得（horse_id 検索 → 戦績取得 の2ステップ）
async function fetchOneHorse(horseName: string): Promise<{
  lastThreeFurlong: number | null
  runningStyle: string | null
  ok: boolean
}> {
  const horseId = await findHorseId(horseName)
  if (!horseId) return { lastThreeFurlong: null, runningStyle: null, ok: false }

  await delay(200)
  const { lastThreeFurlong, frontPositions } = await fetchHorseRaceStats(horseId)
  const runningStyle = inferRunningStyle(frontPositions)

  return { lastThreeFurlong, runningStyle, ok: true }
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
      return NextResponse.json({ error: '出走馬が登録されていません。先に「↻ 出走馬を再検証」を実行してください。' }, { status: 400 })
    }

    const results: Record<string, { lastThreeFurlong: number | null; runningStyle: string | null; ok: boolean }> = {}

    // 4頭ずつ並列処理（レート制限対策）
    const entries = race.entries
    const BATCH = 4

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH)
      const batchResults = await Promise.all(
        batch.map((entry, idx) =>
          delay(idx * 150).then(() => fetchOneHorse(entry.horseName))
        )
      )
      batch.forEach((entry, idx) => {
        results[entry.horseName] = batchResults[idx]
      })
      // バッチ間に500ms待機
      if (i + BATCH < entries.length) await delay(500)
    }

    const successCount = Object.values(results).filter((r) => r.ok).length
    const ltfCount = Object.values(results).filter((r) => r.lastThreeFurlong !== null).length
    const styleCount = Object.values(results).filter((r) => r.runningStyle !== null).length

    return NextResponse.json({
      results,
      raceName: race.name,
      successCount,
      ltfCount,
      styleCount,
      totalCount: entries.length,
      message: `${race.name}: ${entries.length}頭中 上がり3F=${ltfCount}頭・脚質=${styleCount}頭 取得完了`,
    })
  } catch (error) {
    console.error('fetch-training error:', error)
    return NextResponse.json({ error: '取得に失敗しました' }, { status: 500 })
  }
}
