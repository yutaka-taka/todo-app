'use strict'
/**
 * netkeiba から popularity / odds / frameNumber / horseWeight を backfill
 *
 * 戦略:
 *  1. 各レースの開催日について SP schedule (EUC-JP) で全 race_id+name を取得
 *  2. venue+name でマッチして race_id 確定
 *  3. result.html (EUC-JP) で全馬の popularity/odds 等パース
 *  4. RaceResult / RaceEntry を更新
 *
 * 進捗を JSON ファイルに保存し、再実行で続きから処理可能。
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')

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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Cache-Control': 'no-cache',
}

const VENUE_CODES = {
  '札幌': '01', '函館': '02', '福島': '03', '新潟': '04',
  '東京': '05', '中山': '06', '中京': '07', '京都': '08',
  '阪神': '09', '小倉': '10',
}

const PROGRESS_FILE = path.join(__dirname, '.backfill_progress.json')
const SCHEDULE_CACHE = path.join(__dirname, '.backfill_schedule_cache.json')
const SLEEP_MS = 1500
const MAX_RETRIES = 2

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) } catch { return { processed: {}, failed: {} } }
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)) }

function loadCache() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_CACHE, 'utf8')) } catch { return {} }
}
function saveCache(c) { fs.writeFileSync(SCHEDULE_CACHE, JSON.stringify(c)) }

async function fetchEucJp(url) {
  for (let i = 0; i < MAX_RETRIES + 1; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) { await sleep(3000); continue }
        return null
      }
      const buf = await res.arrayBuffer()
      try { return new TextDecoder('euc-jp').decode(buf) }
      catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf) }
    } catch (e) { await sleep(2000) }
  }
  return null
}

// SP schedule から { raceId, name, grade } の配列を取得
async function fetchSchedule(dateStr) {
  const url = `https://race.sp.netkeiba.com/?pid=race_list&kaisai_date=${dateStr}`
  const html = await fetchEucJp(url)
  if (!html) return []
  const found = []
  const seen = new Set()

  // RaceListMainArea ブロック単位でパース
  // 各レースは以下のような構造：
  // <a href="...race_id=XXX">
  //   <div class="Race_Num">
  //   <div class="RaceList_Item02">
  //     <dt class="Race_Name">レース名 <span class="Icon_GradeType N">GX</span></dt>
  //   </div>
  // </a>
  const blockPattern = /<a[^>]+race_id=(\d{12})[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = blockPattern.exec(html)) !== null) {
    const raceId = m[1]
    if (seen.has(raceId)) continue
    const block = m[2]
    // Race_Name は dt 内
    const nameM = block.match(/<dt[^>]*class="Race_Name"[^>]*>([\s\S]*?)<\/dt>/i)
    if (!nameM) continue
    const part = nameM[1]
    const gradeM = part.match(/Icon_GradeType(\d+)/)
    const grade = gradeM ? `G${gradeM[1]}` : null
    const name = part.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!name) continue
    seen.add(raceId)
    found.push({ raceId, name, grade })
  }
  return found
}

// レース名がマッチするか判定（柔軟マッチ）
function nameMatches(target, candidate) {
  if (!target || !candidate) return false
  // 年情報・グレード表記・空白・「ステークス/S」を除去
  const norm = s => s
    .replace(/\s*\d{4}年?\s*$/, '')             // 年
    .replace(/[（(].*?[）)]/g, '')               // (xx) (xx)
    .replace(/G[IⅠⅡⅢ1-3]+|GI{1,3}|G[1-3]/gi, '')  // GI/GII/G1/G2 グレード
    .replace(/ステークス/g, '')                  // ステークス
    .replace(/(?<!ベ|チ|プ|ガ)ーS\b|S\b|S\s|S$/g, '') // S 略字
    .replace(/カップ|杯/g, '')                   // カップ/杯
    .replace(/記念/g, '')                        // 記念（除外しすぎても害は少ない）
    .replace(/[\s　]/g, '')
    .replace(/[ァ-ン]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ーｰ―−ｰ]/g, '')
    .trim()
  const t = norm(target)
  const c = norm(candidate)
  if (!t || !c || t.length < 2 || c.length < 2) return false
  return t === c || t.includes(c) || c.includes(t)
}

// netkeiba race_id を取得
async function findRaceId(race, scheduleCache) {
  const dateKey = race.date.toISOString().slice(0, 10).replace(/-/g, '')
  const venueCode = VENUE_CODES[race.venue]
  if (!venueCode) return null

  // キャッシュから取得 or 取得して保存
  let schedule = scheduleCache[dateKey]
  if (!schedule) {
    schedule = await fetchSchedule(dateKey)
    scheduleCache[dateKey] = schedule
    saveCache(scheduleCache)
    await sleep(SLEEP_MS)
  }

  // 同じ venue + 名前マッチ
  const cleanName = race.name.replace(/\s*\d{4}\s*$/, '').trim()
  for (const item of schedule) {
    if (item.raceId.substring(4, 6) !== venueCode) continue
    if (nameMatches(item.name, cleanName) || nameMatches(cleanName, item.name)) {
      return item.raceId
    }
  }

  // schedule からマッチしない場合、近接日も試す（DB日付の誤りに対応）
  const date = new Date(race.date)
  // ±1日 → ±7日 → ±14日 の順で広げる
  for (const offset of [-1, 1, -7, 7, -14, 14, -2, 2]) {
    const d = new Date(date.getTime() + offset * 86400000)
    const dk = d.toISOString().slice(0, 10).replace(/-/g, '')
    let s = scheduleCache[dk]
    if (!s) {
      s = await fetchSchedule(dk)
      scheduleCache[dk] = s
      saveCache(scheduleCache)
      await sleep(SLEEP_MS)
    }
    for (const item of s) {
      if (item.raceId.substring(4, 6) !== venueCode) continue
      if (nameMatches(item.name, cleanName) || nameMatches(cleanName, item.name)) {
        return item.raceId
      }
    }
  }

  return null
}

// 結果テーブルから全馬パース
function parseResultTable(html) {
  const tableM = html.match(/<table[^>]*id="All_Result_Table"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableM) return []
  const table = tableM[1]
  const rows = Array.from(table.matchAll(/<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi))
  const out = []
  for (const row of rows) {
    const r = row[1]
    // 着順
    const rankM = r.match(/<div[^>]*class="Rank"[^>]*>(\d{1,2})<\/div>/)
    if (!rankM) continue
    const finishPosition = parseInt(rankM[1])

    // 枠番: <td class="Num WakuN">
    const wakuM = r.match(/<td[^>]*class="[^"]*Waku(\d+)[^"]*"[^>]*>/i)
    const frameNumber = wakuM ? parseInt(wakuM[1]) : null

    // 馬番: 2つ目の <td class="Num Txt_C"><div>N</div></td>
    const numMatches = Array.from(r.matchAll(/<td[^>]*class="[^"]*Num\s*Txt_C[^"]*"[^>]*>\s*<div>(\d{1,2})<\/div>/gi))
    const horseNumber = numMatches.length > 0 ? parseInt(numMatches[0][1]) : null

    // 馬名
    const nameM = r.match(/<span[^>]*class="HorseNameSpan"[^>]*>([^<]+)<\/span>/)
              || r.match(/title="([^"]+)"[^>]*>\s*<span[^>]*class="HorseNameSpan"/)
    if (!nameM) continue
    const horseName = nameM[1].trim()
    if (!horseName) continue

    // 人気
    const popM = r.match(/<span[^>]*class="OddsPeople"[^>]*>(\d{1,2})<\/span>/)
    const popularity = popM ? parseInt(popM[1]) : null

    // オッズ
    const oddsM = r.match(/<span[^>]*class="Odds_Ninki"[^>]*>([\d.]+)<\/span>/)
    const odds = oddsM ? parseFloat(oddsM[1]) : null

    // 馬体重: <td class="Weight">462<small>(-4)</small></td>
    const wM = r.match(/<td[^>]*class="Weight"[^>]*>\s*(\d{3})/)
    const horseWeight = wM ? parseInt(wM[1]) : null

    out.push({ finishPosition, horseNumber, horseName, frameNumber, popularity, odds, horseWeight })
  }
  return out
}

async function fetchRaceResult(raceId) {
  const url = `https://race.netkeiba.com/race/result.html?race_id=${raceId}`
  const html = await fetchEucJp(url)
  if (!html) return null
  return parseResultTable(html)
}

function normName(s) {
  return (s || '').replace(/[\s　・]/g, '').trim()
}

async function processRace(race, progress, scheduleCache) {
  const dateKey = race.date.toISOString().slice(0, 10)
  const key = race.id
  if (progress.processed[key]) return { status: 'skip', reason: '済' }

  const raceId = await findRaceId(race, scheduleCache)
  if (!raceId) {
    progress.failed[key] = { name: race.name, date: dateKey, reason: 'race_id未発見' }
    return { status: 'fail', reason: 'race_id未発見' }
  }

  const rows = await fetchRaceResult(raceId)
  await sleep(SLEEP_MS)
  if (!rows || rows.length === 0) {
    progress.failed[key] = { name: race.name, date: dateKey, reason: 'パース失敗', raceId }
    return { status: 'fail', reason: 'パース失敗', raceId }
  }

  // RaceResult / RaceEntry を更新
  let updatedR = 0, updatedE = 0
  const allResults = await prisma.raceResult.findMany({ where: { raceId: race.id } })
  const allEntries = await prisma.raceEntry.findMany({ where: { raceId: race.id } })

  for (const row of rows) {
    const updateData = {}
    if (row.popularity != null) updateData.popularity = row.popularity
    if (row.odds != null) updateData.odds = row.odds
    if (row.horseWeight != null) updateData.horseWeight = row.horseWeight
    if (Object.keys(updateData).length === 0) continue

    // RaceResult
    let result = allResults.find(r => r.horseName === row.horseName)
    if (!result) result = allResults.find(r => normName(r.horseName) === normName(row.horseName))
    if (!result && row.horseNumber) result = allResults.find(r => r.horseNumber === row.horseNumber)
    if (result) {
      await prisma.raceResult.update({ where: { id: result.id }, data: updateData })
      updatedR++
    }

    // RaceEntry
    const entryUpdate = { ...updateData }
    if (row.frameNumber != null) entryUpdate.frameNumber = row.frameNumber
    let entry = allEntries.find(e => e.horseName === row.horseName)
    if (!entry) entry = allEntries.find(e => normName(e.horseName) === normName(row.horseName))
    if (!entry && row.horseNumber) entry = allEntries.find(e => e.horseNumber === row.horseNumber)
    if (entry) {
      await prisma.raceEntry.update({ where: { id: entry.id }, data: entryUpdate })
      updatedE++
    }
  }

  progress.processed[key] = { name: race.name, date: dateKey, raceId, results: updatedR, entries: updatedE, rows: rows.length }
  return { status: 'ok', raceId, results: updatedR, entries: updatedE, rows: rows.length }
}

async function main() {
  const args = process.argv.slice(2)
  const limit = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1]) : null })()
  const grade = (() => { const a = args.find(x => x.startsWith('--grade=')); return a ? a.split('=')[1] : null })()
  const yr = (() => { const a = args.find(x => x.startsWith('--year=')); return a ? a.split('=')[1] : null })()
  const reset = args.includes('--reset')
  const resetCache = args.includes('--reset-cache')

  if (reset) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processed: {}, failed: {} }, null, 2)); console.log('進捗リセット完了'); process.exit(0) }
  if (resetCache) { fs.writeFileSync(SCHEDULE_CACHE, '{}'); console.log('スケジュールキャッシュ削除'); process.exit(0) }

  const progress = loadProgress()
  const scheduleCache = loadCache()

  const where = { results: { some: {} } }
  if (grade) where.grade = grade
  if (yr) where.date = { gte: new Date(`${yr}-01-01`), lt: new Date(`${parseInt(yr)+1}-01-01`) }

  const races = await prisma.race.findMany({ where, orderBy: { date: 'asc' } })
  const remaining = races.filter(r => !progress.processed[r.id])
  const target = limit ? remaining.slice(0, limit) : remaining

  console.log(`対象: ${target.length}/${races.length} レース（処理済${races.length - remaining.length}件）`)
  if (target.length === 0) { console.log('全件処理済み'); await prisma.$disconnect(); return }

  let okCnt = 0, failCnt = 0
  const start = Date.now()

  for (let i = 0; i < target.length; i++) {
    const race = target[i]
    const dk = race.date.toISOString().slice(0, 10)
    process.stdout.write(`[${i+1}/${target.length}] ${dk} ${race.name.substring(0, 25)} ... `)

    const result = await processRace(race, progress, scheduleCache)
    if (result.status === 'ok') {
      console.log(`OK results=${result.results} entries=${result.entries}/${result.rows} (${result.raceId})`)
      okCnt++
    } else if (result.status === 'skip') {
      console.log(`SKIP`)
    } else {
      console.log(`FAIL ${result.reason}${result.raceId ? ` (${result.raceId})` : ''}`)
      failCnt++
    }

    if ((i + 1) % 5 === 0) saveProgress(progress)
  }

  saveProgress(progress)
  const elapsed = Math.round((Date.now() - start) / 1000)
  console.log(`\n=== 完了 ${okCnt}成功 / ${failCnt}失敗 / 経過${elapsed}秒 ===`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
