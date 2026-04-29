'use strict'
/**
 * netkeibaから各馬の通常戦含む完全戦績を取得してHorseStatを再構築
 *
 * 戦略:
 *  1. RaceEntry/RaceResult から horseName と netkeibaの horseId をマップ
 *     (既存scrape済の result.html に horse/{id}/ リンクが含まれる)
 *     なければ db.netkeiba 検索で horseId を取得
 *  2. 各horseの profile page (https://db.netkeiba.com/horse/{id}/) を取得（EUC-JP）
 *  3. 全戦績テーブルをパース → HorseStat 更新
 *
 *  完全戦績で recentForm/distanceData/venueData/surfaceData/raceNameData を再構築
 *  ※ 通常戦も含むのでstatsの精度が劇的向上
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

const PROGRESS_FILE = path.join(__dirname, '.backfill_horse_progress.json')
const HORSE_ID_CACHE = path.join(__dirname, '.backfill_horse_id_cache.json')
const SLEEP_MS = 1500

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return def }
}
function saveJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)) }

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

// 馬名から horseId を検索
async function findHorseId(name) {
  const url = `https://db.netkeiba.com/?pid=horse_list&word=${encodeURIComponent(name)}`
  const html = await fetchEucJp(url)
  if (!html) return null
  // /horse/{12-digit-id}/ パターン
  const matches = Array.from(html.matchAll(/\/horse\/(\d{10,12})\//g))
  if (matches.length === 0) return null
  // 最初のマッチを使用（検索結果の最初の馬）
  return matches[0][1]
}

// 競馬場コード（race_id 4-5桁目）→ 競馬場名
const VENUE_BY_CODE = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟',
  '05': '東京', '06': '中山', '07': '中京', '08': '京都',
  '09': '阪神', '10': '小倉',
}

// 競馬場名（pageに登場する短縮名→正規化）
const VENUE_NORMALIZE = {
  '東京': '東京', '中山': '中山', '阪神': '阪神', '京都': '京都',
  '中京': '中京', '新潟': '新潟', '札幌': '札幌', '函館': '函館',
  '小倉': '小倉', '福島': '福島',
}

// horseの profile から全戦績をパース
// netkeiba /horse/result/{id}/ の固定カラム構成:
//   [0]日付 [1]開催 [2]天気 [3]R [4]レース名 [5]映像 [6]頭数 [7]枠番
//   [8]馬番 [9]オッズ [10]人気 [11]着順 [12]騎手 [13]斤量 [14]距離
function parseHorseProfile(html) {
  const tableM = html.match(/<table[^>]*class="[^"]*db_h_race_results[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableM) return []
  const rows = Array.from(tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
  const races = []
  for (const row of rows) {
    const r = row[1]
    // td のみ（th=ヘッダ行は除外）
    const tds = Array.from(r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map(t => t[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    if (tds.length < 15) continue

    const dateStr = tds[0]
    const dateM = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    if (!dateM) continue
    const date = new Date(parseInt(dateM[1]), parseInt(dateM[2]) - 1, parseInt(dateM[3]))

    const venuePart = tds[1]  // "1阪神6" 等
    let venue = null
    for (const v of Object.keys(VENUE_NORMALIZE)) {
      if (venuePart.includes(v)) { venue = v; break }
    }

    const raceName = tds[4]
    if (!raceName) continue

    // [11] 着順 - "1", "2", ... or "中止"/"除外"
    const finishStr = tds[11]
    if (!/^\d{1,2}$/.test(finishStr)) continue
    const finishPos = parseInt(finishStr)
    if (finishPos < 1 || finishPos > 30) continue

    // [10] 人気
    let popularity = null
    if (/^\d{1,2}$/.test(tds[10])) {
      const p = parseInt(tds[10])
      if (p >= 1 && p <= 30) popularity = p
    }

    // [14] 距離 (例: ダ2000, 芝1600)
    const distM = tds[14].match(/^([芝ダ障])(\d{3,4})/)
    if (!distM) continue
    const surface = distM[1] === '芝' ? '芝' : distM[1] === 'ダ' ? 'ダート' : '障害'
    const distance = parseInt(distM[2])

    // 障害は除外（G1/G2/G3 評価対象外）
    if (surface === '障害') continue

    // グレード判定
    let grade = null
    if (raceName.includes('G1') || raceName.includes('GⅠ') || raceName.includes('(G1)') || raceName.includes('（G1）')) grade = 'G1'
    else if (raceName.includes('G2') || raceName.includes('GⅡ') || raceName.includes('(G2)') || raceName.includes('（G2）')) grade = 'G2'
    else if (raceName.includes('G3') || raceName.includes('GⅢ') || raceName.includes('(G3)') || raceName.includes('（G3）')) grade = 'G3'
    const cleanName = raceName.replace(/\s*\(G\d\)\s*|（G\d）/g, '').replace(/\s*GⅠ|\s*GⅡ|\s*GⅢ\s*|\s*G[123]\s*/g, '').trim()

    races.push({ date, venue, surface, distance, finishPos, raceName: cleanName, grade, popularity })
  }
  return races
}

// HorseStat 更新ロジック
function buildHorseStatsFromRaces(races) {
  const distanceData = {}, venueData = {}, surfaceData = {}, raceNameData = {}
  let totalRaces = 0, totalPlaces = 0, g1Races = 0, g1Places = 0
  let lastRaceDate = null, lastRacePopularity = null

  // 日付の新しい順にソート
  const sorted = [...races].sort((a, b) => b.date.getTime() - a.date.getTime())

  for (const r of races) {
    const placed = r.finishPos <= 2
    totalRaces++
    if (placed) totalPlaces++
    if (r.grade === 'G1') {
      g1Races++
      if (placed) g1Places++
    }
    const dk = String(r.distance)
    if (!distanceData[dk]) distanceData[dk] = { races: 0, places: 0 }
    distanceData[dk].races++; if (placed) distanceData[dk].places++
    if (r.venue) {
      if (!venueData[r.venue]) venueData[r.venue] = { races: 0, places: 0 }
      venueData[r.venue].races++; if (placed) venueData[r.venue].places++
    }
    if (!surfaceData[r.surface]) surfaceData[r.surface] = { races: 0, places: 0 }
    surfaceData[r.surface].races++; if (placed) surfaceData[r.surface].places++
    if (r.raceName) {
      if (!raceNameData[r.raceName]) raceNameData[r.raceName] = { races: 0, places: 0 }
      raceNameData[r.raceName].races++; if (placed) raceNameData[r.raceName].places++
    }
  }

  // recentForm: 直近7レースの着順
  const recentForm = sorted.slice(0, 7).map(r => r.finishPos).join('-')
  if (sorted.length > 0) {
    lastRaceDate = sorted[0].date
    lastRacePopularity = sorted[0].popularity
  }

  return { totalRaces, totalPlaces, g1Races, g1Places, distanceData, venueData, surfaceData, raceNameData, recentForm, lastRaceDate, lastRacePopularity }
}

async function processHorse(horse, progress, idCache) {
  const name = horse.horseName
  if (progress.processed[name]) return { status: 'skip' }

  // horseId 取得
  let horseId = idCache[name]
  if (!horseId) {
    horseId = await findHorseId(name)
    if (horseId) {
      idCache[name] = horseId
      saveJson(HORSE_ID_CACHE, idCache)
    }
    await sleep(SLEEP_MS)
  }
  if (!horseId) {
    progress.failed[name] = { reason: 'horseId未発見' }
    return { status: 'fail', reason: 'horseId未発見' }
  }

  // profile fetch (race history page)
  const url = `https://db.netkeiba.com/horse/result/${horseId}/`
  const html = await fetchEucJp(url)
  await sleep(SLEEP_MS)
  if (!html) {
    progress.failed[name] = { reason: 'profile fetch失敗', horseId }
    return { status: 'fail', reason: 'profile fetch失敗' }
  }

  // 名前一致確認
  if (!html.includes(name)) {
    progress.failed[name] = { reason: '名前一致せず', horseId }
    return { status: 'fail', reason: '名前一致せず' }
  }

  const races = parseHorseProfile(html)
  if (races.length === 0) {
    progress.failed[name] = { reason: 'レース無し', horseId }
    return { status: 'fail', reason: 'レース無し' }
  }

  const stats = buildHorseStatsFromRaces(races)
  await prisma.horseStat.update({
    where: { id: horse.id },
    data: {
      totalRaces: stats.totalRaces,
      totalPlaces: stats.totalPlaces,
      g1Races: stats.g1Races,
      g1Places: stats.g1Places,
      distanceData: stats.distanceData,
      venueData: stats.venueData,
      surfaceData: stats.surfaceData,
      raceNameData: stats.raceNameData,
      recentForm: stats.recentForm,
      lastRaceDate: stats.lastRaceDate,
      lastRacePopularity: stats.lastRacePopularity,
    },
  })

  progress.processed[name] = { horseId, races: races.length, total: stats.totalRaces, places: stats.totalPlaces }
  return { status: 'ok', races: races.length, totalRaces: stats.totalRaces, totalPlaces: stats.totalPlaces }
}

async function main() {
  const args = process.argv.slice(2)
  const limit = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1]) : null })()
  const reset = args.includes('--reset')
  if (reset) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processed: {}, failed: {} }, null, 2)); console.log('進捗リセット完了'); process.exit(0) }

  const progress = loadJson(PROGRESS_FILE, { processed: {}, failed: {} })
  const idCache = loadJson(HORSE_ID_CACHE, {})

  const horses = await prisma.horseStat.findMany({ orderBy: { totalRaces: 'desc' } })
  const remaining = horses.filter(h => !progress.processed[h.horseName])
  const target = limit ? remaining.slice(0, limit) : remaining

  console.log(`対象: ${target.length}/${horses.length} 馬（処理済${horses.length - remaining.length}件）`)
  if (target.length === 0) { console.log('全件処理済'); await prisma.$disconnect(); return }

  let okCnt = 0, failCnt = 0
  const start = Date.now()

  for (let i = 0; i < target.length; i++) {
    const h = target[i]
    process.stdout.write(`[${i+1}/${target.length}] ${h.horseName} ... `)
    const result = await processHorse(h, progress, idCache)
    if (result.status === 'ok') {
      console.log(`OK races=${result.races} total=${result.totalRaces} places=${result.totalPlaces}`)
      okCnt++
    } else if (result.status === 'skip') {
      console.log('SKIP')
    } else {
      console.log(`FAIL ${result.reason}`)
      failCnt++
    }
    if ((i + 1) % 10 === 0) saveJson(PROGRESS_FILE, progress)
  }

  saveJson(PROGRESS_FILE, progress)
  const elapsed = Math.round((Date.now() - start) / 60)
  console.log(`\n=== 完了 ${okCnt}成功 / ${failCnt}失敗 / 経過${elapsed}分 ===`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
