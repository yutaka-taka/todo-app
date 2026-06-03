import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// JST のカレンダー上の「土〜日」週末を、サーバーTZに依存せず確実に算出する。
// レース日時は DB 内で UTC午前0時(=JST 09:00) と JST午前0時(=UTC前日15:00) の
// 2 規約が混在するため、JST の [土00:00, 月00:00) を窓にすれば両規約とも捕捉できる。
// 土曜・日曜のいずれに見ても週末2日分を表示する（旧実装は日曜に当日のみで取りこぼしていた）。
function weekendRangeJst(now: Date): { start: Date; end: Date } {
  const nowJst = new Date(now.getTime() + JST_OFFSET_MS)
  const dow = nowJst.getUTCDay() // JST基準の曜日（0=日, 6=土）
  // 当該週末の土曜までの日数オフセット
  const daysToSat = dow === 0 ? -1 : dow === 6 ? 0 : 6 - dow
  const satJstMidnightUtc = Date.UTC(
    nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() + daysToSat,
  ) - JST_OFFSET_MS
  return {
    start: new Date(satJstMidnightUtc),                 // 土 00:00 JST
    end: new Date(satJstMidnightUtc + 2 * DAY_MS),       // 月 00:00 JST（日曜いっぱいまで）
  }
}

export async function GET(request: NextRequest) {
  try {
    // ?date=YYYY-MM-DD があればその JST カレンダー日の [00:00, 翌00:00) を窓にする。
    // 無ければ従来どおり「今週末(土〜日)」を表示する。
    // レース日時は DB 内で UTC午前0時(=JST 09:00) / JST午前0時(=UTC前日15:00) の
    // 2 規約が混在するが、JST の 24h 窓ならどちらの規約でも当日のレースを捕捉できる。
    const dateParam = request.nextUrl.searchParams.get('date')
    let dayStart: Date
    let dayEnd: Date
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const [y, m, d] = dateParam.split('-').map(Number)
      const startUtc = Date.UTC(y, m - 1, d) - JST_OFFSET_MS // 指定日 00:00 JST
      dayStart = new Date(startUtc)
      dayEnd = new Date(startUtc + DAY_MS)
    } else {
      const wk = weekendRangeJst(new Date())
      dayStart = wk.start
      dayEnd = wk.end
    }

    const races = await prisma.race.findMany({
      where: {
        date: { gte: dayStart, lt: dayEnd },
        grade: { in: ['G1', 'G2', 'G3'] },
      },
      include: {
        entries: { orderBy: { horseNumber: 'asc' } },
      },
      orderBy: [{ date: 'asc' }, { grade: 'asc' }, { name: 'asc' }],
    })

    // 重複レースの表示統合: 同一レースが「正式名」と「別名(年付き)」で二重登録されている
    // ことがある（例: 東京優駿 / 日本ダービー2026）。会場×馬場×距離×JST日付で畳み、
    // 出走馬数が多く・年号サフィックスの無い綺麗な名前の方を代表に採用する。
    const dedup = new Map<string, (typeof races)[number]>()
    const score = (r: (typeof races)[number]) => r.entries.length * 1000 - (/\d{4}/.test(r.name) ? 1 : 0)
    for (const r of races) {
      const jstDay = new Date(new Date(r.date).getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
      const key = `${r.venue}|${r.surface}|${r.distance}|${jstDay}`
      const cur = dedup.get(key)
      if (!cur || score(r) > score(cur)) dedup.set(key, r)
    }
    const deduped = Array.from(dedup.values()).sort((a, b) =>
      a.date.getTime() - b.date.getTime() || a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name))

    return NextResponse.json({
      races: deduped,
      targetDate: dayStart.toISOString(),
    })
  } catch (error) {
    console.error('Races API error:', error)
    return NextResponse.json(
      { error: 'レース情報の取得に失敗しました' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, date, venue, grade, surface, distance } = body

    if (!name || !date || !venue || !grade || !surface || !distance) {
      return NextResponse.json({ error: '必須項目が不足しています' }, { status: 400 })
    }

    const raceDate = new Date(date)
    if (isNaN(raceDate.getTime())) {
      return NextResponse.json({ error: '日付の形式が正しくありません' }, { status: 400 })
    }

    // 同名・同年のレースが既にあれば日付等を更新
    const year = raceDate.getFullYear()
    const existing = await prisma.race.findFirst({
      where: {
        name,
        date: {
          gte: new Date(`${year}-01-01`),
          lt: new Date(`${year + 1}-01-01`),
        },
      },
    })

    if (existing) {
      const updated = await prisma.race.update({
        where: { id: existing.id },
        data: { date: raceDate, venue, grade, surface, distance: Number(distance) },
      })
      return NextResponse.json({ race: updated, action: 'updated' })
    }

    const race = await prisma.race.create({
      data: { name, date: raceDate, venue, grade, surface, distance: Number(distance) },
    })
    return NextResponse.json({ race, action: 'created' })
  } catch (error) {
    console.error('Race POST error:', error)
    return NextResponse.json({ error: 'レースの登録に失敗しました' }, { status: 500 })
  }
}
