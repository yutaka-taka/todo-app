'use strict'
/**
 * 馬プロファイルページから Race + RaceResult を生成して backfill する
 *
 * 既存 backfill_horse_full_history.js は HorseStat の集計のみを更新するが、
 * 本スクリプトは同じ profile ページから個別の Race + RaceResult 行を作る。
 *
 * 目的:
 *   blind test (時系列で RaceResult から動的に統計再構築) で
 *   通常戦の戦績を活用できるようにし、+3pt の精度向上を狙う（80%ロードマップ Step 1）。
 *
 * 戦略:
 *   1. HorseStat 全件をループ
 *   2. 既存 .backfill_horse_id_cache.json から horseId 解決（無ければ検索）
 *   3. /horse/result/{horseId}/ から戦績テーブルをパース（行キャッシュあり）
 *   4. 各レース行について:
 *        - 同日同名(正規化マッチ)の Race があればそれを使用、無ければ create (grade='通常')
 *        - 既存 RaceResult が無ければ create、あれば skip
 *
 * Args:
 *   --limit=N        対象を最初の N 馬に制限（テスト用）
 *   --reset          進捗リセット
 *   --dry-run        DB 書き込み無し、件数のみ出力
 *   --use-cache-only キャッシュにある馬のみ処理（fetch せず DB 反映のみ）
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
}

const PROGRESS_FILE   = path.join(__dirname, '.backfill_raceresult_progress.json')
const HORSE_ID_CACHE  = path.join(__dirname, '.backfill_horse_id_cache.json')
const ROWS_CACHE      = path.join(__dirname, '.backfill_raceresult_rows_cache.json')
const SLEEP_MS = 1500

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return def } }
function saveJson(p, d)   { fs.writeFileSync(p, JSON.stringify(d, null, 2)) }

async function fetchEucJp(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) { await sleep(3000); continue }
        return null
      }
      const buf = await res.arrayBuffer()
      try { return new TextDecoder('euc-jp').decode(buf) }
      catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf) }
    } catch { await sleep(2000) }
  }
  return null
}

async function findHorseId(name) {
  const url = `https://db.netkeiba.com/?pid=horse_list&word=${encodeURIComponent(name)}`
  const html = await fetchEucJp(url)
  if (!html) return null
  const matches = Array.from(html.matchAll(/\/horse\/(\d{10,12})\//g))
  return matches.length ? matches[0][1] : null
}

const VENUE_LIST = ['東京', '中山', '阪神', '京都', '中京', '新潟', '札幌', '函館', '小倉', '福島']

function normName(s) {
  return (s || '')
    // grade 表記 (G1/G2/G3, GI/GII/GIII, GⅠ/GⅡ/GⅢ) を半角丸括弧/全角ともに除去
    .replace(/[(（]\s*G(?:Ⅰ|Ⅱ|Ⅲ|III|II|I|[123])\s*[)）]/g, '')
    .replace(/G(?:Ⅰ|Ⅱ|Ⅲ|III|II|I|[123])/g, '')
    // OP / L / 1勝〜3勝クラス / 1600万下 / 500万下 / 1000万下 等のクラス表記
    .replace(/[(（]\s*(?:OP|L|[1-3]勝クラス|\d{3,4}万下|\d勝クラス|新馬|未勝利)\s*[)）]/g, '')
    // 末尾の西暦 (空白の有無問わず)
    .replace(/\s*\d{4}年?\s*$/, '')
    // 全空白・中黒・括弧を除去
    .replace(/[\s　・]/g, '')
    .replace(/[\(\)（）]/g, '')
    .trim()
}

// netkeiba /horse/result/{id}/ のカラム構成:
//   [0]日付 [1]開催 [2]天気 [3]R [4]レース名 [5]映像 [6]頭数 [7]枠番
//   [8]馬番 [9]オッズ [10]人気 [11]着順 [12]騎手 [13]斤量 [14]距離
function parseHorseProfile(html) {
  const tableM = html.match(/<table[^>]*class="[^"]*db_h_race_results[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableM) return []
  const rows = Array.from(tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
  const out = []
  for (const row of rows) {
    const tds = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map(t => t[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    if (tds.length < 15) continue

    const dateM = tds[0].match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    if (!dateM) continue
    const date = new Date(parseInt(dateM[1]), parseInt(dateM[2]) - 1, parseInt(dateM[3]))

    let venue = null
    for (const v of VENUE_LIST) {
      if (tds[1].includes(v)) { venue = v; break }
    }
    if (!venue) continue  // 海外/地方は対象外

    const raceNameRaw = tds[4]
    if (!raceNameRaw) continue

    if (!/^\d{1,2}$/.test(tds[8])) continue
    const horseNumber = parseInt(tds[8])

    let odds = null
    if (/^[\d.]+$/.test(tds[9])) {
      const o = parseFloat(tds[9])
      if (o > 0 && o < 10000) odds = o
    }

    let popularity = null
    if (/^\d{1,2}$/.test(tds[10])) {
      const p = parseInt(tds[10])
      if (p >= 1 && p <= 30) popularity = p
    }

    if (!/^\d{1,2}$/.test(tds[11])) continue   // 中止/除外/失格は除外
    const finishPosition = parseInt(tds[11])
    if (finishPosition < 1 || finishPosition > 30) continue

    const jockey = tds[12] || null

    let weight = null
    if (/^[\d.]+$/.test(tds[13])) {
      const w = parseFloat(tds[13])
      if (w >= 40 && w <= 65) weight = w
    }

    const distM = tds[14].match(/^([芝ダ障])(\d{3,4})/)
    if (!distM) continue
    if (distM[1] === '障') continue            // 障害は除外
    const surface = distM[1] === '芝' ? '芝' : 'ダート'
    const distance = parseInt(distM[2])

    let grade = '通常'
    if (raceNameRaw.match(/[(（]\s*G(?:Ⅰ|I|1)\s*[)）]|\bG(?:Ⅰ|I|1)\b/)) grade = 'G1'
    else if (raceNameRaw.match(/[(（]\s*G(?:Ⅱ|II|2)\s*[)）]|\bG(?:Ⅱ|II|2)\b/)) grade = 'G2'
    else if (raceNameRaw.match(/[(（]\s*G(?:Ⅲ|III|3)\s*[)）]|\bG(?:Ⅲ|III|3)\b/)) grade = 'G3'

    const cleanName = raceNameRaw
      .replace(/\s*[(（]\s*G(?:Ⅰ|Ⅱ|Ⅲ|III|II|I|[123])\s*[)）]\s*/g, '')
      .replace(/\s*G(?:Ⅰ|Ⅱ|Ⅲ|III|II|I|[123])\s*/g, '')
      .trim()

    out.push({
      date, venue, surface, distance, finishPosition,
      raceName: cleanName, grade, popularity,
      horseNumber, odds, jockey, weight,
    })
  }
  return out
}

async function getRowsForHorse(horse, idCache, rowsCache) {
  const name = horse.horseName
  let horseId = idCache[name]
  if (!horseId) {
    horseId = await findHorseId(name)
    if (horseId) {
      idCache[name] = horseId
      saveJson(HORSE_ID_CACHE, idCache)
    }
    await sleep(SLEEP_MS)
  }
  if (!horseId) return { error: 'horseId未発見' }

  if (rowsCache[horseId]) {
    return {
      horseId,
      rows: rowsCache[horseId].map(r => ({ ...r, date: new Date(r.date) })),
      cached: true,
    }
  }

  const url = `https://db.netkeiba.com/horse/result/${horseId}/`
  const html = await fetchEucJp(url)
  await sleep(SLEEP_MS)
  if (!html) return { error: 'profile fetch失敗', horseId }
  if (!html.includes(name)) return { error: '名前一致せず', horseId }

  const rows = parseHorseProfile(html)
  if (rows.length === 0) return { error: 'レース無し', horseId }

  rowsCache[horseId] = rows.map(r => ({ ...r, date: r.date.toISOString() }))
  saveJson(ROWS_CACHE, rowsCache)
  return { horseId, rows, cached: false }
}

// 同日 Race を全件取得して正規化マッチ（既存があれば既存を使う）
async function findOrCreateRace(row) {
  const dayStart = new Date(row.date.getTime()); dayStart.setHours(0, 0, 0, 0)
  const dayEnd   = new Date(dayStart.getTime() + 86400_000)
  const candidates = await prisma.race.findMany({
    where: { date: { gte: dayStart, lt: dayEnd } },
  })
  const targetNorm = normName(row.raceName)
  for (const c of candidates) {
    if (normName(c.name) === targetNorm) return { race: c, created: false }
  }
  // 同会場で部分一致
  for (const c of candidates) {
    if (c.venue !== row.venue) continue
    const cn = normName(c.name)
    if (cn && targetNorm && (cn.includes(targetNorm) || targetNorm.includes(cn))) {
      return { race: c, created: false }
    }
  }
  const race = await prisma.race.create({
    data: {
      name: row.raceName, date: row.date, venue: row.venue,
      grade: row.grade, surface: row.surface, distance: row.distance,
    },
  })
  return { race, created: true }
}

async function processHorse(horse, progress, idCache, rowsCache, dryRun) {
  const name = horse.horseName
  if (progress.processed[name]) return { status: 'skip' }

  const { horseId, rows, error, cached } = await getRowsForHorse(horse, idCache, rowsCache)
  if (error) {
    progress.failed[name] = { reason: error, horseId }
    return { status: 'fail', reason: error }
  }

  let createdRaces = 0, existingRaces = 0
  let createdResults = 0, existingResults = 0, conflictResults = 0

  for (const row of rows) {
    if (dryRun) continue
    let race
    try {
      const res = await findOrCreateRace(row)
      race = res.race
      if (res.created) createdRaces++; else existingRaces++
    } catch (e) {
      // 同名レース重複等は既存マッチが取れない race のみ。@@unique([name,date]) 違反の場合は再 fetch
      if (e.code === 'P2002') {
        const existing = await prisma.race.findUnique({
          where: { name_date: { name: row.raceName, date: row.date } },
        })
        if (!existing) throw e
        race = existing
        existingRaces++
      } else throw e
    }

    const existing = await prisma.raceResult.findUnique({
      where: { raceId_horseNumber: { raceId: race.id, horseNumber: row.horseNumber } },
    })
    if (existing) {
      // 既存が別馬名ならログ用にカウントだけ。データは触らない
      if (existing.horseName !== name) conflictResults++
      else existingResults++
      continue
    }
    await prisma.raceResult.create({
      data: {
        raceId: race.id,
        finishPosition: row.finishPosition,
        horseNumber: row.horseNumber,
        horseName: name,
        weight: row.weight,
        jockey: row.jockey,
        odds: row.odds,
        popularity: row.popularity,
      },
    })
    createdResults++
  }

  progress.processed[name] = {
    horseId, rows: rows.length, cached: !!cached,
    createdRaces, existingRaces, createdResults, existingResults, conflictResults,
  }
  return {
    status: 'ok', horseId, rows: rows.length, cached: !!cached,
    createdRaces, existingRaces, createdResults, existingResults, conflictResults,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const limit = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1]) : null })()
  const reset = args.includes('--reset')
  const dryRun = args.includes('--dry-run')
  const useCacheOnly = args.includes('--use-cache-only')

  if (reset) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processed: {}, failed: {} }, null, 2))
    console.log('進捗リセット完了'); process.exit(0)
  }

  const progress = loadJson(PROGRESS_FILE, { processed: {}, failed: {} })
  const idCache  = loadJson(HORSE_ID_CACHE, {})
  const rowsCache = loadJson(ROWS_CACHE, {})

  const horses = await prisma.horseStat.findMany({ orderBy: { totalRaces: 'desc' } })
  let target = horses.filter(h => !progress.processed[h.horseName])
  if (useCacheOnly) target = target.filter(h => idCache[h.horseName] && rowsCache[idCache[h.horseName]])
  if (limit) target = target.slice(0, limit)

  console.log(`対象: ${target.length}/${horses.length} 馬（処理済${Object.keys(progress.processed).length}件） dryRun=${dryRun}`)
  if (target.length === 0) { console.log('全件処理済'); await prisma.$disconnect(); return }

  let okCnt = 0, failCnt = 0
  let sumRows = 0, sumCR = 0, sumER = 0, sumCRes = 0, sumERes = 0, sumConf = 0
  const start = Date.now()

  for (let i = 0; i < target.length; i++) {
    const h = target[i]
    process.stdout.write(`[${i+1}/${target.length}] ${h.horseName} ... `)
    let result
    try {
      result = await processHorse(h, progress, idCache, rowsCache, dryRun)
    } catch (e) {
      console.log(`ERROR ${e.message}`)
      progress.failed[h.horseName] = { reason: 'exception:' + e.message }
      failCnt++
      continue
    }
    if (result.status === 'ok') {
      console.log(
        `OK rows=${result.rows}${result.cached ? '(cache)' : ''} ` +
        `race +${result.createdRaces}/=${result.existingRaces} ` +
        `result +${result.createdResults}/=${result.existingResults}` +
        (result.conflictResults ? ` conflict=${result.conflictResults}` : '')
      )
      okCnt++
      sumRows  += result.rows
      sumCR    += result.createdRaces
      sumER    += result.existingRaces
      sumCRes  += result.createdResults
      sumERes  += result.existingResults
      sumConf  += result.conflictResults
    } else if (result.status === 'skip') {
      console.log('SKIP')
    } else {
      console.log(`FAIL ${result.reason}`)
      failCnt++
    }
    if ((i + 1) % 5 === 0) saveJson(PROGRESS_FILE, progress)
  }

  saveJson(PROGRESS_FILE, progress)
  const sec = Math.round((Date.now() - start) / 1000)
  console.log(
    `\n=== 完了 ${okCnt}成功 / ${failCnt}失敗 / ${sec}秒\n` +
    `   profile rows total: ${sumRows}\n` +
    `   Race      created: ${sumCR}  existing: ${sumER}\n` +
    `   RaceResult created: ${sumCRes} existing: ${sumERes} conflict: ${sumConf}`
  )
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
