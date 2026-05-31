'use strict'
/**
 * JRA全レース カレンダー駆動取り込み
 *
 * 使い方:
 *   node scripts/fetch_jra_full_calendar.js --from=2025-05-01 --to=2026-05-13
 *   node scripts/fetch_jra_full_calendar.js --from=2021-01-01 --to=2025-04-30 --resume
 *   node scripts/fetch_jra_full_calendar.js --from=2025-01-01 --to=2026-05-13 --dry-run
 *   node scripts/fetch_jra_full_calendar.js --from=2025-01-01 --to=2026-05-13 --limit=5
 *
 * フラグ:
 *   --from=DATE       開始日 (YYYY-MM-DD)
 *   --to=DATE         終了日 (YYYY-MM-DD)
 *   --dry-run         DB 書き込みなし、件数のみ確認
 *   --limit=N         取込み対象開催日を最初の N 日に制限
 *   --resume          進捗ファイルから続きを実行
 *   --rebuild-stats   完了後に HorseStat を POST /api/reanalyze で再構築
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

function loadEnv(f) {
  try {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()
const PROGRESS_FILE = path.join(__dirname, '.fetch_jra_full_progress.json')
const SLEEP_MS = 1500
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Referer': 'https://race.netkeiba.com/',
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return def } }
function saveJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)) }
function stripTags(s) { return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() }

async function fetchEucJp(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) {
        if (res.status === 429) { console.log('  Rate limited, waiting 30s...'); await sleep(30000); continue }
        if (res.status >= 500) { await sleep(5000); continue }
        return null
      }
      const buf = await res.arrayBuffer()
      try { return new TextDecoder('euc-jp').decode(buf) } catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf) }
    } catch { await sleep(2000) }
  }
  return null
}

// 土曜・日曜の日付リストを生成
function generateWeekendDates(from, to) {
  const dates = []
  const cur = new Date(from)
  cur.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  while (cur <= end) {
    const dow = cur.getDay()
    if (dow === 0 || dow === 6) {
      dates.push(new Date(cur))
    }
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function toYmd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${dd}`
}

// ローカル日時でISO日付文字列を生成（UTC変換しない）
function toIsoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// レース一覧ページから race_id を抽出
async function fetchRaceList(dateYmd) {
  // race_list.html はJSで動的ロードのため race_list_sub.html を使用
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${dateYmd}`
  const html = await fetchEucJp(url)
  if (!html) return []
  const ids = new Set()
  for (const m of html.matchAll(/race_id=(\d{12})/g)) ids.add(m[1])
  return [...ids]
}

// venue コード → 会場名マッピング（race_id の 5-6桁目）
const VENUE_CODE_MAP = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉',
}

function venueFromRaceId(raceId) {
  const code = raceId.slice(4, 6)
  return VENUE_CODE_MAP[code] ?? null
}

function raceNumberFromId(raceId) {
  return parseInt(raceId.slice(10, 12)) || null
}

function parseHorseWeight(s) {
  if (!s) return { hw: null, change: null }
  const m = s.match(/^(\d+)\s*\(([+-]?\d+)\)/)  // "522 (+6)" 形式に対応
  if (m) return { hw: parseInt(m[1]), change: parseInt(m[2]) }
  const n = parseInt(s)
  return { hw: isNaN(n) ? null : n, change: null }
}

function extractHorseId(rowHtml) {
  const m = rowHtml.match(/\/horse\/(\d{10,12})\//)
  return m ? m[1] : null
}

function normalizeGrade(className) {
  if (!className) return '通常'
  const s = className.toUpperCase()
  if (/G1/.test(s) || /GⅠ/.test(s) || /GI(?!I)/.test(s)) return 'G1'
  if (/G2/.test(s) || /GⅡ/.test(s) || /GII(?!I)/.test(s)) return 'G2'
  if (/G3/.test(s) || /GⅢ/.test(s) || /GIII/.test(s)) return 'G3'
  return '通常'
}

// レース名中の (G1)/(G2)/(G3) からグレードを判定する。
// クラス欄(RaceData02)はグレードを持たないことが多いため、名前を優先する。
// 障害(J.G1 等)は平地グレードに含めない。
function gradeFromName(name) {
  if (!name) return null
  if (/\(?\s*J\s*[.\-]?\s*G\s*[I1Ⅰ2Ⅱ3Ⅲ]/i.test(name) || name.includes('障害')) return null
  if (/\(\s*G\s*(?:1|I|Ⅰ)\s*\)/i.test(name)) return 'G1'
  if (/\(\s*G\s*(?:2|II|Ⅱ)\s*\)/i.test(name)) return 'G2'
  if (/\(\s*G\s*(?:3|III|Ⅲ)\s*\)/i.test(name)) return 'G3'
  return null
}

// レース結果ページをパース
function parseRaceResultHtml(raceId, html, kaisaiDate) {
  const out = {
    raceId,
    _kaisaiDate: kaisaiDate,
    raceName: '',
    venue: venueFromRaceId(raceId),
    surface: '芝',
    distance: 0,
    grade: '通常',
    className: null,
    weather: null,
    trackCondition: null,
    raceNumber: raceNumberFromId(raceId),
    startTime: null,
    results: [],
  }

  // レース名 - result.html の RaceList_NameBox か RaceName クラスを試みる
  let titleM = html.match(/<div[^>]+class="[^"]*RaceList_NameBox[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (!titleM) titleM = html.match(/<div[^>]+class="[^"]*RaceName[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (titleM) {
    let name = stripTags(titleM[1]).trim()
    // "1R 3歳未勝利 10:15発走" のようなら R番号と発走時刻を除去
    name = name.replace(/^\d+R\s*/, '').replace(/\s+\d{1,2}:\d{2}発走.*$/, '').trim()
    out.raceName = name
  }
  // <title> タグからフォールバック
  if (!out.raceName) {
    const tM = html.match(/<title>([^<]+?)(?:\s*[|｜]\s*|\s+結果|\s+競馬|$)/)
    if (tM) out.raceName = tM[1].replace(/^\d+R\s*/, '').trim()
  }

  // RaceData01: "11:00発走 / 芝1600m (右) / 天候:晴 / 馬場:良"
  const data1 = html.match(/<div[^>]+class="[^"]*RaceData01[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (data1) {
    const txt = stripTags(data1[1])
    const surfM = txt.match(/(芝|ダ|障)(\d{3,4})m/i)
    if (surfM) {
      out.surface = surfM[1] === 'ダ' ? 'ダート' : surfM[1] === '障' ? '障害' : '芝'
      out.distance = parseInt(surfM[2])
    }
    const weatherM = txt.match(/天候:(\S+)/)
    if (weatherM) out.weather = weatherM[1]
    const condM = txt.match(/馬場:(\S+)/)
    if (condM) out.trackCondition = condM[1]
    const startM = txt.match(/(\d{1,2}):(\d{2})発走/)
    if (startM) out.startTime = `${startM[1]}:${startM[2]}`
  }

  // RaceData02: "1回 東京 1日目 / 3歳新馬 / 16頭"
  const data2 = html.match(/<div[^>]+class="[^"]*RaceData02[^"]*"[^>]*>([\s\S]*?)<\/div>/)
  if (data2) {
    const txt = stripTags(data2[1])
    // 会場は raceId から取れているがここでも確認
    for (const [, name] of Object.entries(VENUE_CODE_MAP)) {
      if (txt.includes(name)) { out.venue = name; break }
    }
    const classM = txt.match(/(新馬|未勝利|1勝クラス|2勝クラス|3勝クラス|オープン|OP|L|G[123Ⅰ-Ⅲ]+)/i)
    if (classM) {
      out.className = classM[1]
      out.grade = normalizeGrade(classM[1])
    }
  }

  // レース名に含まれる (G1)/(G2)/(G3) を最優先（クラス欄はグレードを持たないことが多い）
  const nameGrade = gradeFromName(out.raceName)
  if (nameGrade) out.grade = nameGrade

  // 結果テーブル
  const tableM = html.match(/<table[^>]+class="[^"]*RaceTable01[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (tableM) {
    const rows = [...tableM[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    for (const row of rows) {
      const cols = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => stripTags(c[1]).trim())
      if (cols.length < 12) continue
      if (!cols[2] || !/^\d+$/.test(cols[2].trim())) continue  // 馬番が数字でなければスキップ

      const finishPosRaw = cols[0].trim()
      const finishPos = parseInt(finishPosRaw)
      const isScratched = isNaN(finishPos)

      // 実際のカラム構造 (15列):
      // [0]着順 [1]枠 [2]馬番 [3]馬名 [4]性齢 [5]斤量 [6]騎手 [7]タイム [8]着差
      // [9]人気 [10]単勝オッズ [11]後3F [12]コーナー [13]厩舎 [14]馬体重
      const hwData = parseHorseWeight(cols[14] || '')
      const horseNameRaw = cols[3] || ''
      const horseName = horseNameRaw.split(/[\s　]/)[0].trim()
      if (!horseName) continue

      const sexAgeRaw = cols[4] || ''
      const sexM = sexAgeRaw.match(/^([牡牝セ騸])(\d+)$/)
      const sex = sexM ? sexM[1] : null
      const age = sexM ? parseInt(sexM[2]) : null

      out.results.push({
        finishPosition: isScratched ? null : finishPos,
        scratchReason: isScratched ? finishPosRaw : null,
        frameNumber: parseInt(cols[1]) || null,
        horseNumber: parseInt(cols[2]),
        horseName,
        netkeibaHorseId: extractHorseId(row[1]),
        sex,
        age,
        weight: parseFloat(cols[5]) || null,
        jockey: cols[6] || null,
        time: cols[7] || null,
        margin: cols[8] || null,
        popularity: parseInt(cols[9]) || null,
        odds: parseFloat(cols[10]) || null,
        rapidIncrease: parseFloat(cols[11]) || null,
        cornerPositions: cols[12] || null,
        horseWeight: hwData.hw,
        weightChange: hwData.change,
      })
    }
  }

  return out
}

// DB に1レース分を書き込む
async function saveRaceResult(parsed, dryRun) {
  if (!parsed.raceName || parsed.distance === 0 || !parsed.venue || parsed.results.length === 0) return false

  if (dryRun) {
    console.log(`    [dry-run] ${parsed.venue} R${parsed.raceNumber} ${parsed.raceName} ${parsed.surface}${parsed.distance}m ${parsed.results.length}頭`)
    return true
  }

  try {
    const dateOnly = new Date(parsed._kaisaiDate + 'T00:00:00+09:00')

    // netkeibaRaceId または (name, date) で既存レースを検索し、なければ作成
    const raceData = {
      name: parsed.raceName,
      date: dateOnly,
      venue: parsed.venue,
      grade: parsed.grade,
      surface: parsed.surface,
      distance: parsed.distance,
      trackCondition: parsed.trackCondition ?? null,
      raceNumber: parsed.raceNumber,
      netkeibaRaceId: parsed.raceId,
      weather: parsed.weather ?? null,
      startTime: parsed.startTime ?? null,
      className: parsed.className ?? null,
    }
    let existing = await prisma.race.findFirst({
      where: { OR: [{ netkeibaRaceId: parsed.raceId }, { name: parsed.raceName, date: dateOnly }] },
    })
    let race
    if (existing) {
      race = await prisma.race.update({ where: { id: existing.id }, data: raceData })
    } else {
      race = await prisma.race.create({ data: raceData })
    }

    // RaceEntry upsert（出走馬）
    for (const r of parsed.results) {
      try {
        await prisma.raceEntry.upsert({
          where: { raceId_horseNumber: { raceId: race.id, horseNumber: r.horseNumber } },
          create: {
            raceId: race.id,
            horseNumber: r.horseNumber,
            frameNumber: r.frameNumber,
            horseName: r.horseName,
            age: r.age,
            sex: r.sex,
            weight: r.weight,
            horseWeight: r.horseWeight,
            jockey: r.jockey,
            odds: r.odds,
            popularity: r.popularity,
          },
          update: {
            horseName: r.horseName,
            jockey: r.jockey,
            odds: r.odds,
            popularity: r.popularity,
            horseWeight: r.horseWeight,
          },
        })
      } catch { /* skip duplicate */ }
    }

    // RaceResult upsert
    for (const r of parsed.results) {
      try {
        await prisma.raceResult.upsert({
          where: { raceId_horseNumber: { raceId: race.id, horseNumber: r.horseNumber } },
          create: {
            raceId: race.id,
            finishPosition: r.finishPosition,
            horseNumber: r.horseNumber,
            horseName: r.horseName,
            age: r.age,
            sex: r.sex,
            weight: r.weight,
            horseWeight: r.horseWeight,
            weightChange: r.weightChange,
            jockey: r.jockey,
            time: r.time,
            margin: r.margin,
            odds: r.odds,
            popularity: r.popularity,
            scratchReason: r.scratchReason,
            cornerPositions: r.cornerPositions,
            rapidIncrease: r.rapidIncrease,
            netkeibaHorseId: r.netkeibaHorseId,
          },
          update: {
            finishPosition: r.finishPosition,
            horseName: r.horseName,
            horseWeight: r.horseWeight,
            weightChange: r.weightChange,
            jockey: r.jockey,
            time: r.time,
            odds: r.odds,
            popularity: r.popularity,
            cornerPositions: r.cornerPositions,
            rapidIncrease: r.rapidIncrease,
          },
        })
      } catch { /* skip duplicate */ }
    }

    return true
  } catch (err) {
    console.error(`  DB write error: ${err.message}`)
    return false
  }
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/)
      return m ? [m[1], m[2] ?? true] : [a, true]
    })
  )

  const fromDate = args.from
  const toDate = args.to
  const dryRun = !!args['dry-run']
  const limit = args.limit ? parseInt(args.limit) : Infinity
  const resume = !!args.resume
  const rebuildStats = !!args['rebuild-stats']

  if (!fromDate || !toDate) {
    console.error('Usage: node fetch_jra_full_calendar.js --from=YYYY-MM-DD --to=YYYY-MM-DD')
    process.exit(1)
  }

  const progress = resume ? loadJson(PROGRESS_FILE, { processed: [], totalRaces: 0, totalResults: 0, errors: [] })
                          : { processed: [], totalRaces: 0, totalResults: 0, errors: [] }
  const processedSet = new Set(progress.processed)

  let dates = generateWeekendDates(fromDate, toDate)
  if (resume) dates = dates.filter(d => !processedSet.has(toIsoDate(d)))
  if (dates.length > limit) dates = dates.slice(0, limit)

  console.log(`=== JRA 全レース取り込み ===`)
  console.log(`期間: ${fromDate} → ${toDate}`)
  console.log(`対象開催日数: ${dates.length}日 ${dryRun ? '(dry-run)' : ''}`)

  let totalRaces = progress.totalRaces
  let totalResults = progress.totalResults

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]
    const ymd = toYmd(date)
    const isoDate = toIsoDate(date)
    console.log(`\n[${di + 1}/${dates.length}] ${isoDate} (${ymd})`)

    // RaceCalendar を pending で作成
    if (!dryRun) {
      try {
        await prisma.raceCalendar.upsert({
          where: { date: new Date(isoDate + 'T00:00:00+09:00') },
          create: { date: new Date(isoDate + 'T00:00:00+09:00'), totalRaces: 0, status: 'pending' },
          update: { status: 'pending' },
        })
      } catch {}
    }

    // レースID一覧を取得
    const raceIds = await fetchRaceList(ymd)
    console.log(`  レース数: ${raceIds.length}`)

    if (raceIds.length === 0) {
      if (!dryRun) {
        try {
          await prisma.raceCalendar.update({
            where: { date: new Date(isoDate + 'T00:00:00+09:00') },
            data: { totalRaces: 0, status: 'done', lastFetched: new Date() },
          })
        } catch {}
      }
      processedSet.add(isoDate)
      continue
    }

    if (!dryRun) {
      try {
        await prisma.raceCalendar.update({
          where: { date: new Date(isoDate + 'T00:00:00+09:00') },
          data: { totalRaces: raceIds.length, status: 'partial' },
        })
      } catch {}
    }

    let fetchedCount = 0
    let errorLog = []

    for (const raceId of raceIds) {
      await sleep(SLEEP_MS)
      try {
        const html = await fetchEucJp(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`)
        if (!html) { errorLog.push(`fetch_fail:${raceId}`); continue }

        const parsed = parseRaceResultHtml(raceId, html, isoDate)
        if (!parsed.results.length) { console.log(`  ${raceId}: パース結果なし`); continue }

        const ok = await saveRaceResult(parsed, dryRun)
        if (ok) {
          fetchedCount++
          totalRaces++
          totalResults += parsed.results.length
          if (!dryRun) console.log(`  ✓ ${parsed.venue} R${parsed.raceNumber} ${parsed.raceName} ${parsed.surface}${parsed.distance}m (${parsed.results.length}頭)`)
        }
      } catch (err) {
        console.error(`  エラー ${raceId}: ${err.message}`)
        errorLog.push(`${raceId}:${err.message}`)
      }
    }

    // RaceCalendar を done に更新
    if (!dryRun) {
      try {
        await prisma.raceCalendar.update({
          where: { date: new Date(isoDate + 'T00:00:00+09:00') },
          data: {
            fetchedRaces: fetchedCount,
            status: errorLog.length === 0 ? 'done' : 'partial',
            lastFetched: new Date(),
            errorLog: errorLog.length ? errorLog.join('\n') : null,
          },
        })
      } catch {}
    }

    processedSet.add(isoDate)
    progress.processed = [...processedSet]
    progress.totalRaces = totalRaces
    progress.totalResults = totalResults
    progress.errors = errorLog
    saveJson(PROGRESS_FILE, progress)

    console.log(`  完了: ${fetchedCount}/${raceIds.length} レース (累計 ${totalRaces} レース / ${totalResults} 結果行)`)
  }

  console.log(`\n=== 完了 ===`)
  console.log(`取り込み: ${totalRaces} レース / ${totalResults} 結果行`)

  if (rebuildStats && !dryRun) {
    console.log('\nHorseStat 再構築中...')
    try {
      const res = await fetch('http://localhost:3000/api/reanalyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json()
      console.log(`HorseStat 再構築完了: ${data.horsesSaved ?? '?'} 頭`)
    } catch (err) {
      console.error('HorseStat 再構築失敗:', err.message)
    }
  }

  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
