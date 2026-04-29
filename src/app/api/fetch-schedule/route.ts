import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { addDays, format } from 'date-fns'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

// 場コード → 競馬場名
const VENUE_BY_CODE: Record<string, string> = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉',
}

// レース名 → 競馬場/グレード/馬場/距離 の辞書
const RACE_INFO: Record<string, { venue: string; grade: string; surface: string; distance: number }> = {
  // G1
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
  // G2
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
  '阪神大賞典': { venue: '阪神', grade: 'G2', surface: '芝', distance: 3000 },
  'アメリカジョッキークラブカップ': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  '日経新春杯': { venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
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
  '日経賞': { venue: '中山', grade: 'G2', surface: '芝', distance: 2500 },
  // JRA 2026 重賞一覧との照合で追加（2026-04-30）
  'チューリップ賞': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  'ニュージーランドトロフィー': { venue: '東京', grade: 'G2', surface: '芝', distance: 1600 },
  '阪神牝馬ステークス': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1600 },
  '紫苑ステークス': { venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  'セントライト記念': { venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  '毎日杯': { venue: '阪神', grade: 'G3', surface: '芝', distance: 1800 },  // 参考用
  'アイルランドトロフィー': { venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  '阪神カップ': { venue: '阪神', grade: 'G2', surface: '芝', distance: 1400 },
}

type RaceFound = { name: string; date: Date; info: (typeof RACE_INFO)[string] }

// 当該週の土曜日を返す（日曜 → 前日の土曜、平日 → 次の土曜）
function getStartSaturday(today: Date): Date {
  const dow = today.getDay()
  if (dow === 0) return addDays(today, -1)          // 日曜 → 昨日(土)
  return addDays(today, (6 - dow + 7) % 7)           // 土曜 → 当日、平日 → 次の土曜
}

// SP race_list から1週末分のG1/G2レースを抽出する
// 仕組み: race.sp.netkeiba.com の race_list ページは静的HTMLにrace_idを含む。
// race_id の場コードと dayNum で「どの会場がどの曜日に主要レースを持つか」を特定し、
// EUC-JPデコードしたHTMLからレース名を照合する。
async function fetchWeekendRaces(saturday: Date): Promise<RaceFound[]> {
  const satStr = format(saturday, 'yyyyMMdd')
  const sunday = addDays(saturday, 1)

  let html: string
  try {
    const res = await fetch(
      `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${satStr}`,
      { headers: HEADERS },
    )
    if (!res.ok) return []
    const buffer = await res.arrayBuffer()
    try { html = new TextDecoder('euc-jp').decode(buffer) }
    catch { html = new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
  } catch {
    return []
  }

  // race_idパターン: YYYY(4) + 場コード(2) + dayNum(2) + 何か(2) + レース番号(2)
  const raceIdPat = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
  const seen = new Set<string>()
  const mainRaces: Array<{ venueCode: string; dayNum: number; raceNum: number }> = []
  let m: RegExpExecArray | null
  while ((m = raceIdPat.exec(html)) !== null) {
    const key = m[1] + m[2] + m[3] + m[4] + m[5]
    if (seen.has(key)) continue
    seen.add(key)
    const raceNum = parseInt(m[5])
    if (raceNum >= 10) {  // R10以降 = その日のメインレース群
      mainRaces.push({ venueCode: m[2], dayNum: parseInt(m[4]), raceNum })
    }
  }
  if (mainRaces.length === 0) return []

  // 土曜の dayNum（最小値）を基準に日曜を算出
  const minDay = Math.min(...mainRaces.map(c => c.dayNum))
  const sunDay = minDay + 1

  // 各会場が「土のみ」「日のみ」「両日」どのパターンかを判定
  const venueDay: Record<string, 'sat' | 'sun' | 'both'> = {}
  for (const c of mainRaces) {
    const venue = VENUE_BY_CODE[c.venueCode]
    if (!venue) continue
    const isSat = c.dayNum === minDay
    const isSun = c.dayNum === sunDay
    if (venueDay[venue] === undefined) {
      venueDay[venue] = isSun ? 'sun' : 'sat'
    } else if ((venueDay[venue] === 'sat' && isSun) || (venueDay[venue] === 'sun' && isSat)) {
      venueDay[venue] = 'both'
    }
  }

  // 会場ごとに race_id リンク周辺のHTML断片を収集し、タグ除去したコンテキストを作る。
  // ページ全体を検索するとプロモーション/来週予告テキストに誤マッチするため、
  // 実際のrace_idリンクに近い箇所にレース名が存在するかだけを確認する。
  const venueCtx: Record<string, string> = {}
  {
    const ctxPat = /race_id=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/g
    let cm: RegExpExecArray | null
    while ((cm = ctxPat.exec(html)) !== null) {
      const venue = VENUE_BY_CODE[cm[2]]
      if (!venue) continue
      const s = Math.max(0, cm.index - 1500)
      const e = Math.min(html.length, cm.index + 1500)
      const chunk = html.slice(s, e).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
      venueCtx[venue] = (venueCtx[venue] ?? '') + chunk
    }
  }

  const found: RaceFound[] = []

  for (const [raceName, info] of Object.entries(RACE_INFO)) {
    if (!venueDay[info.venue]) continue  // 今週末その会場に開催がない

    // 表記ゆれ対応（全角・半角括弧、カップ↔C、ステークス↔S 等）
    const variants = new Set<string>()
    const addVariants = (s: string) => {
      variants.add(s)
      variants.add(s.replace(/（/g, '(').replace(/）/g, ')'))
      // カップ↔C / ステークス↔S / フィリーズ↔F / トロフィー↔T
      if (s.includes('カップ')) variants.add(s.replace(/カップ/g, 'C'))
      if (s.endsWith('C') && !s.endsWith('CC')) variants.add(s.replace(/C$/, 'カップ'))
      if (s.includes('ステークス')) variants.add(s.replace(/ステークス/g, 'S'))
      if (s.endsWith('S') && !s.endsWith('SS')) variants.add(s.replace(/S$/, 'ステークス'))
      if (s.includes('フィリーズ')) variants.add(s.replace(/フィリーズ/g, 'F'))
      if (s.endsWith('F') && !s.endsWith('FF')) variants.add(s.replace(/F$/, 'フィリーズ'))
      if (s.includes('トロフィー')) variants.add(s.replace(/トロフィー/g, 'T'))
      if (s.endsWith('T') && !s.endsWith('TT')) variants.add(s.replace(/T$/, 'トロフィー'))
      if (s.includes('東京スポーツ杯')) variants.add(s.replace(/東京スポーツ杯/g, '東スポ杯'))
      if (s.includes('東スポ杯')) variants.add(s.replace(/東スポ杯/g, '東京スポーツ杯'))
      if (s.includes('アメリカジョッキークラブカップ')) variants.add(s.replace(/アメリカジョッキークラブカップ/g, 'AJCC'))
      if (s.includes('AJCC')) variants.add(s.replace(/AJCC/g, 'アメリカJCC'))
      if (s === '弥生賞ディープインパクト記念') variants.add('弥生賞')
      if (s === '弥生賞') variants.add('弥生賞ディープインパクト記念')
      if (s.includes('阪神ジュベナイルフィリーズ')) variants.add(s.replace(/阪神ジュベナイルフィリーズ/g, '阪神JF'))
      if (s.includes('朝日杯フューチュリティ')) variants.add(s.replace(/朝日杯フューチュリティステークス|朝日杯フューチュリティ/g, '朝日杯FS'))
    }
    addVariants(raceName)
    // 二度通して括弧変換とC↔カップ等を組み合わせる
    Array.from(variants).forEach(v => addVariants(v))

    // race_id周辺のコンテキストにのみ存在するか確認
    const ctx = venueCtx[info.venue] ?? ''
    const inPage = Array.from(variants).some(v => ctx.includes(v))
    if (!inPage) continue

    // レース日の特定
    const day = venueDay[info.venue]
    let raceDate: Date
    if (day === 'sat') {
      raceDate = saturday
    } else if (day === 'sun') {
      raceDate = sunday
    } else {
      // 両日開催の会場: コンテキストで曜日判定、不明な場合は日曜
      let nameIdx = -1
      Array.from(variants).some(v => {
        const idx = ctx.indexOf(v)
        if (idx >= 0) { nameIdx = idx; return true }
        return false
      })
      const nearby = nameIdx >= 0 ? ctx.slice(Math.max(0, nameIdx - 300), nameIdx + 300) : ''
      raceDate = nearby.includes('土曜') ? saturday : sunday
    }

    const year = raceDate.getFullYear()
    const key = `${raceName}${year}`
    if (!found.find(r => r.name === key)) {
      found.push({ name: key, date: raceDate, info })
    }
  }

  return found
}

function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

export async function POST() {
  try {
    const today = new Date()
    const allRaces: RaceFound[] = []

    // 今週末から12週先まで走査
    let sat = getStartSaturday(today)
    for (let i = 0; i < 12; i++) {
      const races = await fetchWeekendRaces(sat)
      for (const r of races) {
        if (!allRaces.find(x => x.name === r.name)) allRaces.push(r)
      }
      sat = addDays(sat, 7)
      if (i < 11) await delay(300)
    }

    if (allRaces.length === 0) {
      return NextResponse.json(
        { error: 'netkeiba.com からレース日程を取得できませんでした。手動でレースを登録してください。' },
        { status: 404 },
      )
    }

    // DBへ保存 / 日付更新
    let added = 0
    let updated = 0
    const savedRaces: Array<{ name: string; date: string; grade: string; venue: string }> = []

    for (const { name, date, info } of allRaces) {
      const raceYear = date.getFullYear()
      const existing = await prisma.race.findFirst({
        where: {
          name,
          date: {
            gte: new Date(`${raceYear}-01-01`),
            lt: new Date(`${raceYear + 1}-01-01`),
          },
        },
      })

      if (existing) {
        if (existing.date.getTime() !== date.getTime()) {
          await prisma.race.update({
            where: { id: existing.id },
            data: { date, venue: info.venue, grade: info.grade, surface: info.surface, distance: info.distance },
          })
          updated++
          savedRaces.push({ name, date: date.toISOString().slice(0, 10), grade: info.grade, venue: info.venue })
        }
      } else {
        await prisma.race.create({
          data: { name, date, venue: info.venue, grade: info.grade, surface: info.surface, distance: info.distance },
        })
        added++
        savedRaces.push({ name, date: date.toISOString().slice(0, 10), grade: info.grade, venue: info.venue })
      }
    }

    return NextResponse.json({
      message: `${added}件追加・${updated}件更新しました（取得合計 ${allRaces.length}件）`,
      added,
      updated,
      total: allRaces.length,
      races: savedRaces,
    })
  } catch (error) {
    console.error('fetch-schedule error:', error)
    return NextResponse.json(
      { error: 'netkeiba.com からレース日程を取得できませんでした。手動でレースを登録してください。' },
      { status: 500 },
    )
  }
}
