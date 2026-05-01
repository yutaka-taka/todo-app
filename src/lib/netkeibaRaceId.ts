import { addDays, subDays, format } from 'date-fns'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

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

// SPスケジュールページからG1クラスレースIDを探す
// venue: 競馬場名、raceDate: レース日
export async function findNetkeibaRaceId(venue: string, raceDate: Date): Promise<string | null> {
  const venueCode = VENUE_CODES[venue]
  if (!venueCode) return null

  const sat = nearestSaturday(raceDate)
  const satStr = format(sat, 'yyyyMMdd')
  const isSaturday = raceDate.getDay() === 6

  try {
    const res = await fetch(
      `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${satStr}`,
      { headers: HEADERS },
    )
    if (!res.ok) return null
    const html = await res.text()

    const pattern = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
    const candidates: Array<{ raceId: string; dayNum: number; raceNum: number }> = []
    const seen = new Set<string>()
    let m
    while ((m = pattern.exec(html)) !== null) {
      const raceId = m[1] + m[2] + m[3] + m[4] + m[5]
      if (seen.has(raceId) || m[2] !== venueCode) continue
      seen.add(raceId)
      candidates.push({ raceId, dayNum: parseInt(m[4]), raceNum: parseInt(m[5]) })
    }

    const r11r12 = candidates.filter((c) => c.raceNum === 11 || c.raceNum === 12)
    if (r11r12.length === 0) return null
    r11r12.sort((a, b) => a.dayNum - b.dayNum)
    const minDay = r11r12[0].dayNum

    if (isSaturday) {
      return r11r12.find((c) => c.dayNum === minDay && c.raceNum === 11)?.raceId
        ?? r11r12.find((c) => c.dayNum === minDay)?.raceId ?? null
    } else {
      const sunDay = minDay + 1
      return r11r12.find((c) => c.dayNum === sunDay && c.raceNum === 11)?.raceId
        ?? r11r12.find((c) => c.dayNum === sunDay)?.raceId ?? null
    }
  } catch {
    return null
  }
}

// 単勝オッズを取得してパースする内部共通ロジック
async function fetchOddsEntries(netkeibaRaceId: string): Promise<Array<{ horseNumber: number; odds: number }>> {
  const res = await fetch(
    `https://race.netkeiba.com/odds/odds_get_form.html?type=b1&race_id=${netkeibaRaceId}`,
    { headers: HEADERS },
  )
  if (!res.ok) return []

  const buffer = await res.arrayBuffer()
  let html: string
  try { html = new TextDecoder('euc-jp').decode(buffer) }
  catch { html = new TextDecoder('utf-8', { fatal: false }).decode(buffer) }

  const tableM = html.match(/<table[^>]*class="[^"]*RaceOdds_HorseList_Table[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableM) return []

  const oddsEntries: Array<{ horseNumber: number; odds: number }> = []
  for (const row of Array.from(tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))) {
    const tds = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
    if (tds.length < 4) continue
    const texts = tds.map((td) => td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    const horseNumber = parseInt(texts[1])
    if (isNaN(horseNumber) || horseNumber < 1 || horseNumber > 18) continue
    const oddsText = texts[3]
    if (!oddsText || oddsText.includes('-')) continue
    const odds = parseFloat(oddsText)
    if (!isNaN(odds)) oddsEntries.push({ horseNumber, odds })
  }
  return oddsEntries
}

// 単勝オッズ取得 → 馬番→人気順位のマップを返す
// オッズ未確定（---.-）の場合は空オブジェクトを返す
export async function fetchOddsRanking(netkeibaRaceId: string): Promise<Record<number, number>> {
  try {
    const entries = await fetchOddsEntries(netkeibaRaceId)
    if (entries.length === 0) return {}
    entries.sort((a, b) => a.odds - b.odds)
    const result: Record<number, number> = {}
    entries.forEach((item, i) => { result[item.horseNumber] = i + 1 })
    return result
  } catch {
    return {}
  }
}

// 単勝オッズ取得 → 馬番→{popularity, odds}のマップを返す
export async function fetchOddsAndPopularity(
  netkeibaRaceId: string,
): Promise<Record<number, { popularity: number; odds: number }>> {
  try {
    const entries = await fetchOddsEntries(netkeibaRaceId)
    if (entries.length === 0) return {}
    entries.sort((a, b) => a.odds - b.odds)
    const result: Record<number, { popularity: number; odds: number }> = {}
    entries.forEach((item, i) => { result[item.horseNumber] = { popularity: i + 1, odds: item.odds } })
    return result
  } catch {
    return {}
  }
}
