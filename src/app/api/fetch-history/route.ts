import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { addDays, format, addWeeks, startOfYear, getYear } from 'date-fns'

export const maxDuration = 300

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

const VENUE_BY_CODE: Record<string, string> = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉',
}

// fetch-scheduleと共有のレース情報辞書
const RACE_INFO: Record<string, { venue: string; grade: string; surface: string; distance: number }> = {
  'フェブラリーステークス': { venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  '高松宮記念': { venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  '大阪杯': { venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  '桜花賞': { venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  '皐月賞': { venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  '天皇賞（春）': { venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  'NHKマイルカップ': { venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  'ヴィクトリアマイル': { venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  'オークス': { venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  '日本ダービー': { venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  '安田記念': { venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  '宝塚記念': { venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  'スプリンターズステークス': { venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  '秋華賞': { venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  '菊花賞': { venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  '天皇賞（秋）': { venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  'エリザベス女王杯': { venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  'マイルチャンピオンシップ': { venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  'ジャパンカップ': { venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  'チャンピオンズカップ': { venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  '阪神ジュベナイルフィリーズ': { venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  '朝日杯フューチュリティステークス': { venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  '有馬記念': { venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  'ホープフルステークス': { venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  '弥生賞ディープインパクト記念': { venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  'スプリングステークス': { venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  'フィリーズレビュー': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1400 },
  'アーリントンカップ': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  '京都記念': { venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  '中山記念': { venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  '金鯱賞': { venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  'フローラステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 2000 },
  '青葉賞': { venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  '京都新聞杯': { venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  '目黒記念': { venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  'マーメイドステークス': { venue: '阪神', grade: 'G2', surface: '芝', distance: 2000 },
  '函館記念': { venue: '函館', grade: 'G2', surface: '芝', distance: 2000 },
  '新潟記念': { venue: '新潟', grade: 'G2', surface: '芝', distance: 2000 },
  'オールカマー': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  '神戸新聞杯': { venue: '中京', grade: 'G2', surface: '芝', distance: 2200 },
  'ローズステークス': { venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  '京都大賞典': { venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  '府中牝馬ステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  'アルゼンチン共和国杯': { venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  'ステイヤーズステークス': { venue: '中山', grade: 'G2', surface: '芝', distance: 3600 },
  'チャレンジカップ': { venue: '阪神', grade: 'G2', surface: '芝', distance: 2000 },
  '毎日王冠': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  'セントウルステークス': { venue: '中京', grade: 'G2', surface: '芝', distance: 1200 },
  'サウジアラビアロイヤルカップ': { venue: '東京', grade: 'G2', surface: '芝', distance: 1600 },
  '富士ステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 1600 },
  'デイリー杯2歳ステークス': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  '東京スポーツ杯2歳ステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  'ラジオNIKKEI賞': { venue: '福島', grade: 'G2', surface: '芝', distance: 1800 },
  'プロキオンステークス': { venue: '中京', grade: 'G2', surface: 'ダート', distance: 1400 },
  'エプソムカップ': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  // 追加 G2（2026-04-30）
  '京王杯スプリングカップ': { venue: '東京', grade: 'G2', surface: '芝', distance: 1400 },
  '東海ステークス': { venue: '中京', grade: 'G2', surface: 'ダート', distance: 1800 },
  'スワンステークス': { venue: '京都', grade: 'G2', surface: '芝', distance: 1400 },
  'マイラーズカップ': { venue: '京都', grade: 'G2', surface: '芝', distance: 1600 },
  '札幌記念': { venue: '札幌', grade: 'G2', surface: '芝', distance: 2000 },
  'ダイヤモンドステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 3400 },
  'シリウスステークス': { venue: '中京', grade: 'G2', surface: 'ダート', distance: 2000 },
  'みやこステークス': { venue: '京都', grade: 'G2', surface: 'ダート', distance: 1800 },
  '京王杯2歳ステークス': { venue: '東京', grade: 'G2', surface: '芝', distance: 1400 },
  '京阪杯': { venue: '京都', grade: 'G2', surface: '芝', distance: 1200 },
  '京成杯オータムハンデキャップ': { venue: '中山', grade: 'G2', surface: '芝', distance: 1600 },
  // JRA 2026 重賞一覧との照合で追加
  'チューリップ賞': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  'ニュージーランドトロフィー': { venue: '東京', grade: 'G2', surface: '芝', distance: 1600 },
  '紫苑ステークス': { venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  'アイルランドトロフィー': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  '阪神カップ': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1400 },
  'アメリカジョッキークラブカップ': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  'セントライト記念': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  '阪神大賞典': { venue: '阪神', grade: 'G2', surface: '芝', distance: 3000 },
  '日経賞': { venue: '中山', grade: 'G2', surface: '芝', distance: 2500 },
  'AJCC': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  '日経新春杯': { venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  '共同通信杯': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  'きさらぎ賞': { venue: '中京', grade: 'G2', surface: '芝', distance: 1800 },
  '小倉大賞典': { venue: '小倉', grade: 'G2', surface: '芝', distance: 1800 },
}

function decodeEucJp(buffer: ArrayBuffer): string {
  try { return new TextDecoder('euc-jp').decode(buffer) }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
}

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

type StatRecord = Record<string, { races: number; places: number }>

function mergeStatRecord(existing: StatRecord, key: string, placed: boolean): StatRecord {
  const prev = existing[key] ?? { races: 0, places: 0 }
  return { ...existing, [key]: { races: prev.races + 1, places: prev.places + (placed ? 1 : 0) } }
}

function prependForm(existingForm: string | null, position: number, maxLen = 7): string {
  const parts = existingForm ? existingForm.split('-').map(Number).filter((n) => n > 0) : []
  return [position, ...parts].slice(0, maxLen).join('-')
}

// 週末のレース結果をSPページからスクレイプ
async function fetchWeekendRaceIds(saturday: Date): Promise<Array<{ raceId: string; venueCode: string }>> {
  const satStr = format(saturday, 'yyyyMMdd')
  try {
    const res = await fetch(
      `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${satStr}`,
      { headers: HEADERS },
    )
    if (!res.ok) return []
    const html = decodeEucJp(await res.arrayBuffer())

    const raceIds: Array<{ raceId: string; venueCode: string }> = []
    const seen = new Set<string>()
    const pat = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
    let m: RegExpExecArray | null
    while ((m = pat.exec(html)) !== null) {
      const raceId = m[1] + m[2] + m[3] + m[4] + m[5]
      const raceNum = parseInt(m[5])
      if (seen.has(raceId)) continue
      seen.add(raceId)
      if (raceNum >= 10) raceIds.push({ raceId, venueCode: m[2] })
    }
    return raceIds
  } catch { return [] }
}

// SPレース結果ページからレース名と着順を取得
async function fetchRaceResult(raceId: string): Promise<{
  raceName: string | null
  results: Array<{ position: number; horseName: string; jockey: string; popularity: number }>
}> {
  try {
    // PC版の結果ページを使用（構造が安定している）
    const res = await fetch(
      `https://race.netkeiba.com/race/result.html?race_id=${raceId}`,
      { headers: HEADERS },
    )
    if (!res.ok) return { raceName: null, results: [] }
    const html = decodeEucJp(await res.arrayBuffer())

    // レース名を抽出
    const nameM = html.match(/class="RaceName"[^>]*>([\s\S]*?)<\/h1>/i)
      ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const raceName = nameM ? nameM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim() : null

    // 着順テーブルを抽出: class="HorseList"の行
    const results: Array<{ position: number; horseName: string; jockey: string; popularity: number }> = []
    const rowPat = /<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi
    for (const row of Array.from(html.matchAll(rowPat))) {
      const r = row[1]
      const posM = r.match(/class="(?:Rank|Jyuni)[^"]*"[^>]*>\s*<span[^>]*>(\d+)<\/span>/)
        ?? r.match(/class="(?:Rank|Jyuni)[^"]*"[^>]*>(\d+)</)
      if (!posM) continue
      const position = parseInt(posM[1])
      if (isNaN(position) || position > 18) continue

      const nameM2 = r.match(/class="Horse(?:Name)?[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)
      if (!nameM2) continue
      const horseName = nameM2[1].trim()

      const jockeyM = r.match(/class="Jockey"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)
      const jockey = jockeyM ? jockeyM[1].trim() : ''

      const popM = r.match(/class="Popular"[^>]*>\s*(\d+)\s*</)
      const popularity = popM ? parseInt(popM[1]) : 0

      if (horseName) results.push({ position, horseName, jockey, popularity })
    }

    return { raceName, results }
  } catch {
    return { raceName: null, results: [] }
  }
}

// レース名をRACE_INFOのキーと照合
function matchRaceName(pageRaceName: string | null): [string, typeof RACE_INFO[string]] | null {
  if (!pageRaceName) return null
  const normalized = pageRaceName.replace(/\s*\d{4}年?\s*/g, '').replace(/\s+/g, '').trim()
  for (const [name, info] of Object.entries(RACE_INFO)) {
    if (normalized.includes(name) || name.includes(normalized)) return [name, info]
  }
  return null
}

// HorseStatを更新（バッチ学習用・重み調整なし）
async function updateHorseStat(
  horseName: string,
  position: number,
  raceInfo: typeof RACE_INFO[string],
  raceDate: Date,
  raceName: string,
): Promise<void> {
  const placing = position <= 2
  const isG1 = raceInfo.grade === 'G1'
  const dk = String(raceInfo.distance)
  const raceKey = raceName

  try {
    const existing = await prisma.horseStat.findUnique({ where: { horseName } })
    if (existing) {
      await prisma.horseStat.update({
        where: { horseName },
        data: {
          totalRaces:   existing.totalRaces + 1,
          totalPlaces:  placing ? existing.totalPlaces + 1 : existing.totalPlaces,
          g1Races:      isG1 ? existing.g1Races + 1 : existing.g1Races,
          g1Places:     isG1 && placing ? existing.g1Places + 1 : existing.g1Places,
          distanceData: mergeStatRecord(existing.distanceData as StatRecord, dk, placing),
          venueData:    mergeStatRecord(existing.venueData    as StatRecord, raceInfo.venue, placing),
          surfaceData:  mergeStatRecord(existing.surfaceData  as StatRecord, raceInfo.surface, placing),
          raceNameData: mergeStatRecord(existing.raceNameData as StatRecord, raceKey, placing),
          recentForm:   placing ? prependForm(existing.recentForm, position) : existing.recentForm,
          lastRaceDate: existing.lastRaceDate && existing.lastRaceDate > raceDate
            ? existing.lastRaceDate : raceDate,
        },
      })
    } else if (placing) {
      // 入着馬のみ新規作成（未知馬の全着順レコードは作らない）
      await prisma.horseStat.create({
        data: {
          horseName,
          totalRaces:   1,
          totalPlaces:  1,
          g1Races:      isG1 ? 1 : 0,
          g1Places:     isG1 ? 1 : 0,
          distanceData: { [dk]: { races: 1, places: 1 } },
          venueData:    { [raceInfo.venue]: { races: 1, places: 1 } },
          surfaceData:  { [raceInfo.surface]: { races: 1, places: 1 } },
          raceNameData: { [raceKey]: { races: 1, places: 1 } },
          recentForm:   String(position),
          lastRaceDate: raceDate,
        },
      })
    }
  } catch { /* skip individual errors */ }
}

export async function POST(request: NextRequest) {
  try {
    const { yearFrom = 2021, yearTo = 2025 } = await request.json()
    const startTime = Date.now()
    const TIME_LIMIT_MS = 250_000  // 250秒でタイムアウト

    let processedRaces = 0
    let horsesUpdated = 0
    let weekendsScanned = 0

    // 対象年の全土曜日を列挙
    const saturdays: Date[] = []
    for (let year = yearFrom; year <= yearTo; year++) {
      let sat = startOfYear(new Date(year, 0, 1))
      // 最初の土曜日まで進める
      while (sat.getDay() !== 6) sat = addDays(sat, 1)
      while (getYear(sat) === year) {
        saturdays.push(new Date(sat))
        sat = addWeeks(sat, 1)
      }
    }

    for (const saturday of saturdays) {
      if (Date.now() - startTime > TIME_LIMIT_MS) break

      const raceIds = await fetchWeekendRaceIds(saturday)
      weekendsScanned++
      if (raceIds.length === 0) { await delay(150); continue }

      for (const { raceId, venueCode } of raceIds) {
        if (Date.now() - startTime > TIME_LIMIT_MS) break
        const venue = VENUE_BY_CODE[venueCode]
        if (!venue) continue

        // 既にDBに存在するレースはスキップ（重複防止）
        const year = parseInt(raceId.slice(0, 4))
        const alreadyExists = false  // 常に最新結果を優先

        await delay(200)
        const { raceName, results } = await fetchRaceResult(raceId)
        if (!raceName || results.length === 0) continue

        const matched = matchRaceName(raceName)
        if (!matched) continue
        const [baseRaceName, raceInfo] = matched
        if (raceInfo.venue !== venue) continue  // 会場が一致しない場合はスキップ

        const raceDate = new Date(`${year}-${raceId.slice(4, 6)}-${raceId.slice(6, 8)}`)
        if (isNaN(raceDate.getTime())) continue

        const fullRaceName = `${baseRaceName}${year}`

        // Raceレコードのupsert
        try {
          await prisma.race.upsert({
            where: { name_date: { name: fullRaceName, date: raceDate } },
            create: {
              name: fullRaceName,
              date: raceDate,
              venue: raceInfo.venue,
              grade: raceInfo.grade,
              surface: raceInfo.surface,
              distance: raceInfo.distance,
              analyzed: true,
            },
            update: { analyzed: true },
          })
        } catch { continue }

        // 各馬のHorseStatを更新
        let localHorses = 0
        for (const result of results) {
          await updateHorseStat(result.horseName, result.position, raceInfo, raceDate, baseRaceName)
          localHorses++
        }

        processedRaces++
        horsesUpdated += localHorses
        void alreadyExists  // unused var suppress
      }
      await delay(150)
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000)

    return NextResponse.json({
      processedRaces,
      horsesUpdated,
      weekendsScanned,
      elapsed,
      message: `${weekendsScanned}週をスキャン、${processedRaces}件のG1/G2レース処理完了、${horsesUpdated}頭のデータを更新しました（${elapsed}秒）`,
    })
  } catch (error) {
    console.error('fetch-history error:', error)
    return NextResponse.json({ error: '過去レース収集に失敗しました' }, { status: 500 })
  }
}
