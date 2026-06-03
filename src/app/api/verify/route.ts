import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import { addDays, subDays, startOfDay, endOfDay } from 'date-fns'
import { fetchOddsAndPopularity } from '@/lib/netkeibaRaceId'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

// 競馬場名 → netkeiba 場コード（2桁）
const VENUE_CODES: Record<string, string> = {
  '札幌': '01', '函館': '02', '福島': '03', '新潟': '04',
  '東京': '05', '中山': '06', '中京': '07', '京都': '08',
  '阪神': '09', '小倉': '10',
}

function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)) }

function nearestSaturday(today: Date): Date {
  const dow = today.getDay()
  if (dow === 6) return today
  if (dow === 0) return subDays(today, 1)
  return addDays(today, 6 - dow)
}

// SP 版スケジュールページから race_id を取得
// 返値: { raceId, venueCode, kaisaiNum, dayNum, raceNum, kaisaiDate(YYYYMMDD) }
// 注: ページには複数の RaceListDayWrap ブロックがあり、来週のG1プレビューも含む。
//     各ブロックの data-kaisaidate を見て、当該週末（土日）のみ抽出する。
async function fetchWeekendRaceIds(
  saturdayStr: string,
  sundayStr: string,
): Promise<Array<{ raceId: string; venueCode: string; kaisaiNum: number; dayNum: number; raceNum: number; kaisaiDate: string }>> {
  try {
    const res = await fetch(
      `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${saturdayStr}`,
      { headers: HEADERS },
    )
    if (!res.ok) return []
    const html = await res.text()

    const seen = new Set<string>()
    const results: Array<{ raceId: string; venueCode: string; kaisaiNum: number; dayNum: number; raceNum: number; kaisaiDate: string }> = []

    for (const block of splitDayWrapBlocks(html)) {
      // ブロック内の data-kaisaidate="YYYYMMDD" を取得（先頭の jyo_tab li から）
      const dateMatch = block.match(/data-kaisaidate="(\d{8})"/)
      const kaisaiDate = dateMatch?.[1]
      if (!kaisaiDate || (kaisaiDate !== saturdayStr && kaisaiDate !== sundayStr)) continue

      const pattern = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
      let m
      while ((m = pattern.exec(block)) !== null) {
        const raceId = m[1] + m[2] + m[3] + m[4] + m[5]
        if (seen.has(raceId)) continue
        seen.add(raceId)
        results.push({
          raceId,
          venueCode: m[2],
          kaisaiNum: parseInt(m[3]),
          dayNum: parseInt(m[4]),
          raceNum: parseInt(m[5]),
          kaisaiDate,
        })
      }
    }
    return results
  } catch {
    return []
  }
}

// RaceListDayWrap ブロックを div ネストカウントで安全に切り出す
function splitDayWrapBlocks(html: string): string[] {
  const blocks: string[] = []
  const openRegex = /<div class="RaceListDayWrap"[^>]*>/g
  let m
  while ((m = openRegex.exec(html)) !== null) {
    const start = m.index
    const openLen = m[0].length
    let depth = 1
    let j = start + openLen
    while (j < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', j)
      const nextClose = html.indexOf('</div>', j)
      if (nextClose < 0) { j = html.length; break }
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++
        j = nextOpen + 4
      } else {
        depth--
        j = nextClose + 6
      }
    }
    blocks.push(html.slice(start, j))
    openRegex.lastIndex = j
  }
  return blocks
}

// netkeiba shutuba ページから出走馬を取得（EUC-JP デコード対応）
async function scrapeEntries(raceId: string): Promise<Array<{
  horseNumber: number
  frameNumber: number | null
  horseName: string
  age: number | null
  sex: string | null
  jockey: string | null
  trainer: string | null
}>> {
  try {
    const res = await fetch(
      `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`,
      { headers: HEADERS },
    )
    if (!res.ok) return []

    // EUC-JP デコード（Node.js 18+ は TextDecoder で EUC-JP をサポート）
    const buffer = await res.arrayBuffer()
    let html: string
    try {
      html = new TextDecoder('euc-jp').decode(buffer)
    } catch {
      html = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    }

    const entries: Array<{
      horseNumber: number; frameNumber: number | null
      horseName: string; age: number | null; sex: string | null; jockey: string | null; trainer: string | null
    }> = []

    // HorseList の各行をパース
    const rowPattern = /<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi
    for (const row of Array.from(html.matchAll(rowPattern))) {
      const r = row[1]

      // 馬番: <td class="UmabanN Txt_C">N</td>
      const umabanM = r.match(/class="Umaban\d+[^"]*"[^>]*>(\d{1,2})</)
      if (!umabanM) continue
      const horseNumber = parseInt(umabanM[1])
      if (horseNumber < 1 || horseNumber > 18) continue

      // 枠番: <td class="WakuN">
      const wakuM = r.match(/class="Waku(\d)"/)
      const frameNumber = wakuM ? parseInt(wakuM[1]) : null

      // 馬名: horse リンクの title 属性（EUC-JP デコード後は正常な日本語）
      const horseM = r.match(/\/horse\/\d+[^>]+title="([^"]+)"/)
      if (!horseM) continue
      const horseName = horseM[1].trim()
      if (!horseName || horseName.length < 2) continue

      // 性齢: <td class="Barei Txt_C">牡3</td>
      const bareiM = r.match(/class="Barei[^"]*"[^>]*>([^<]+)</)
      let sex: string | null = null
      let age: number | null = null
      if (bareiM) {
        const text = bareiM[1].trim()
        const saM = text.match(/(牡|牝|セ)(\d+)/)
        if (saM) { sex = saM[1]; age = parseInt(saM[2]) }
      }

      // 騎手: jockey リンクの title 属性
      const jockeyM = r.match(/\/jockey\/[^"]+[^>]+title="([^"]+)"/)
      const jockey = jockeyM ? jockeyM[1].trim() : null

      // 調教師: trainer リンクの title 属性
      const trainerM = r.match(/\/trainer\/[^"]+[^>]+title="([^"]+)"/)
      const trainer = trainerM ? trainerM[1].trim() : null

      entries.push({ horseNumber, frameNumber, horseName, age, sex, jockey, trainer })
    }

    return entries
  } catch {
    return []
  }
}

// 週末スケジュールから DB レースに対応する race_id を返す
// kaisaiDate で日付を直接マッチさせる（旧来の dayNum ヒューリスティック不要）
function findRaceIdForDbRace(
  allRaceIds: Array<{ raceId: string; venueCode: string; kaisaiNum: number; dayNum: number; raceNum: number; kaisaiDate: string }>,
  venue: string,
  raceDateStr: string, // YYYYMMDD
): string | null {
  const venueCode = VENUE_CODES[venue]
  if (!venueCode) return null

  const candidates = allRaceIds.filter(
    (x) => x.venueCode === venueCode && x.kaisaiDate === raceDateStr && (x.raceNum === 11 || x.raceNum === 12),
  )
  if (candidates.length === 0) return null

  return (
    candidates.find((x) => x.raceNum === 11)?.raceId
    ?? candidates.find((x) => x.raceNum === 12)?.raceId
    ?? null
  )
}

export async function POST() {
  try {
    const today = new Date()
    const saturday = startOfDay(nearestSaturday(today))
    const sunday = endOfDay(addDays(saturday, 1))

    const races = await prisma.race.findMany({
      where: {
        date: { gte: saturday, lte: sunday },
        grade: { in: ['G1', 'G2', 'G3'] },
      },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
      orderBy: { date: 'asc' },
    })

    if (races.length === 0) {
      return NextResponse.json({ error: '今週末の重賞レースが見つかりません' }, { status: 404 })
    }

    type RaceResult = { raceName: string; raceDate: string; verified: number; message: string }
    const raceResults: RaceResult[] = []
    let totalNew = 0
    const allHorseNames: string[] = []

    const racesNeedEntries = races.filter((r) => r.entries.length === 0)
    const racesHaveEntries = races.filter((r) => r.entries.length > 0)

    // 既存エントリーのあるレース
    for (const race of racesHaveEntries) {
      raceResults.push({
        raceName: race.name,
        raceDate: format(new Date(race.date), 'M月d日(E)', { locale: ja }),
        verified: race.entries.length,
        message: `${race.entries.length}頭は登録済み`,
      })
      allHorseNames.push(...race.entries.map((e) => e.horseName))
    }

    if (racesNeedEntries.length === 0) {
      return NextResponse.json({
        verified: allHorseNames.length,
        raceName: races[0].name,
        raceDate: format(new Date(races[0].date), 'M月d日(E)', { locale: ja }),
        verifiedHorses: allHorseNames,
        totalEntries: allHorseNames.length,
        message: '全レースの出走馬は登録済みです',
        races: raceResults,
      })
    }

    // SP スケジュールページから全 race_id を取得
    const saturdayStr = format(saturday, 'yyyyMMdd')
    const sundayStr = format(addDays(saturday, 1), 'yyyyMMdd')
    const allRaceIds = await fetchWeekendRaceIds(saturdayStr, sundayStr)

    if (allRaceIds.length === 0) {
      for (const race of racesNeedEntries) {
        raceResults.push({
          raceName: race.name,
          raceDate: format(new Date(race.date), 'M月d日(E)', { locale: ja }),
          verified: 0,
          message: 'スケジュールページへのアクセスに失敗しました',
        })
      }
    } else {
      for (const race of racesNeedEntries) {
        const raceDate = new Date(race.date)
        const raceDateStr = format(raceDate, 'yyyyMMdd')

        const raceId = findRaceIdForDbRace(allRaceIds, race.venue, raceDateStr)

        if (!raceId) {
          raceResults.push({
            raceName: race.name,
            raceDate: format(raceDate, 'M月d日(E)', { locale: ja }),
            verified: 0,
            message: `${race.venue}のrace_idが見つかりませんでした`,
          })
          continue
        }

        await delay(500)
        const entries = await scrapeEntries(raceId)

        if (entries.length === 0) {
          raceResults.push({
            raceName: race.name,
            raceDate: format(raceDate, 'M月d日(E)', { locale: ja }),
            verified: 0,
            message: '出走馬の取得に失敗しました（出馬表未確定の可能性）',
          })
          continue
        }

        let saved = 0
        for (const e of entries) {
          try {
            await prisma.raceEntry.upsert({
              where: { raceId_horseNumber: { raceId: race.id, horseNumber: e.horseNumber } },
              create: {
                raceId: race.id,
                horseNumber: e.horseNumber,
                frameNumber: e.frameNumber,
                horseName: e.horseName,
                age: e.age,
                sex: e.sex,
                jockey: e.jockey,
                trainer: e.trainer,
              },
              update: {
                frameNumber: e.frameNumber,
                horseName: e.horseName,
                age: e.age,
                sex: e.sex,
                jockey: e.jockey,
                trainer: e.trainer,
              },
            })
            saved++
            allHorseNames.push(e.horseName)
          } catch { /* 個別エラーはスキップ */ }
        }

        // エントリ登録直後にオッズ人気をDB保存（木〜土曜に確定するため失敗は無視）
        let oddsCount = 0
        try {
          const oddsMap = await fetchOddsAndPopularity(raceId)
          for (const [numStr, { popularity, odds }] of Object.entries(oddsMap)) {
            const horseNumber = parseInt(numStr)
            await prisma.raceEntry.updateMany({
              where: { raceId: race.id, horseNumber },
              data: { popularity, odds },
            })
            oddsCount++
          }
        } catch { /* オッズ未確定の場合は無視 */ }

        totalNew += saved
        raceResults.push({
          raceName: race.name,
          raceDate: format(raceDate, 'M月d日(E)', { locale: ja }),
          verified: saved,
          message: saved > 0
            ? `${saved}頭を登録${oddsCount > 0 ? `・${oddsCount}頭の人気/オッズ取得` : '（オッズ未確定）'}`
            : '出走馬の保存に失敗しました',
        })
      }
    }

    const totalVerified = totalNew + racesHaveEntries.reduce((s, r) => s + r.entries.length, 0)

    return NextResponse.json({
      verified: totalVerified,
      raceName: races[0].name,
      raceDate: format(new Date(races[0].date), 'M月d日(E)', { locale: ja }),
      verifiedHorses: allHorseNames,
      totalEntries: allHorseNames.length,
      message:
        totalNew > 0
          ? `${totalNew}頭の出走馬データをネットから取得しました`
          : totalVerified > 0
            ? '全レースの出走馬は登録済みです'
            : 'ネットからのデータ取得に失敗しました。手動で出走馬を登録してください',
      races: raceResults,
    })
  } catch (error) {
    console.error('Verify API error:', error)
    return NextResponse.json({ error: '再検証に失敗しました' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const today = new Date()
    const saturday = startOfDay(nearestSaturday(today))
    const sunday = endOfDay(addDays(saturday, 1))

    const races = await prisma.race.findMany({
      where: {
        date: { gte: saturday, lte: sunday },
        grade: { in: ['G1', 'G2', 'G3'] },
      },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
      orderBy: { date: 'asc' },
    })

    if (races.length === 0) return NextResponse.json({ raceName: null, entryCount: 0 })

    const totalEntries = races.reduce((sum, r) => sum + r.entries.length, 0)

    return NextResponse.json({
      raceName: races.map((r) => r.name.replace(/\d{4}$/, '')).join('・'),
      raceDate: format(new Date(races[0].date), 'M月d日(E)', { locale: ja }),
      entryCount: totalEntries,
      hasEntries: totalEntries > 0,
    })
  } catch (error) {
    console.error('Verify GET error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}
