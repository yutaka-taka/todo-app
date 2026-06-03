'use strict'
/**
 * netkeiba から血統（父・母・父父・父母・母父・母母）を取得し HorseStat に保存する。
 *
 *   node scripts/fetch_pedigree.js [--limit=N] [--delay=350] [--refetch] [--race=<raceId>]
 *
 * - 馬名検索 → 馬個体ID解決 → 血統ページ(/horse/ped/{id}/)をパース。
 * - チェックポイント方式: sire が既に入っている馬はスキップ（--refetch で再取得）。
 * - 既定の優先順位: ①未来レース出走馬 ②重賞出走馬 ③最近のレース ④その他。
 *   途中で止まっても「いま予想したい馬」から埋まる。
 * - --race=<raceId>: その1レースの出走馬だけを狙い撃ち取得（過去レース・結果未取込みでも
 *   raceEntry から拾える）。特定レースの予想を血統込みで即検証したいとき用。
 * - 礼儀正しいレート制限（既定 350ms）。失敗は数回リトライ後スキップ。
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
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ja-JP,ja;q=0.9',
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function fetchEucJp(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) { await sleep(500 * (i + 1)); continue }
      const buf = await res.arrayBuffer()
      return new TextDecoder('euc-jp').decode(buf)
    } catch {
      await sleep(500 * (i + 1))
    }
  }
  return null
}

// 馬名 → 馬個体ID（10桁）。完全一致を優先、無ければ先頭。
async function resolveHorseId(name) {
  const url = `https://db.netkeiba.com/?pid=horse_list&word=${encodeURIComponent(name)}&match=partial_match`
  const html = await fetchEucJp(url)
  if (!html) return null
  const pairs = [...html.matchAll(/\/horse\/(\d{10})\/"[^>]*>([^<]+)</g)].map(m => ({ id: m[1], name: m[2].trim() }))
  if (pairs.length === 0) return null
  const exact = pairs.find(p => p.name === name)
  return (exact ?? pairs[0]).id
}

function cellName(cellHtml) {
  const a = cellHtml.match(/<a[^>]*href="https:\/\/db\.netkeiba\.com\/horse\/[0-9a-z]+\/"[^>]*>([\s\S]*?)<\/a>/i)
  if (!a) return null
  let t = a[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  t = t.split('\n')[0].trim()
  return t || null
}

// 血統ページHTML → {sire,dam,sireOfSire,damOfSire,sireOfDam,damOfDam}
function parsePed(html) {
  const tbl = html.match(/<table[^>]*class="[^"]*blood_table[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tbl) return null
  const cells = [...tbl[1].matchAll(/<td[^>]*rowspan="(\d+)"[^>]*>([\s\S]*?)<\/td>/gi)]
  const rs16 = cells.filter(c => c[1] === '16').map(c => cellName(c[2]))
  const rs8 = cells.filter(c => c[1] === '8').map(c => cellName(c[2]))
  if (!rs16[0]) return null
  return {
    sire: rs16[0] ?? null, dam: rs16[1] ?? null,
    sireOfSire: rs8[0] ?? null, damOfSire: rs8[1] ?? null,
    sireOfDam: rs8[2] ?? null, damOfDam: rs8[3] ?? null,
  }
}

// 単一レースの出走馬名（refetch でなければ sire 取得済みは除外）
async function getRaceHorses(raceId, refetch) {
  const entries = await prisma.raceEntry.findMany({
    where: { raceId }, select: { horseName: true }, orderBy: { horseNumber: 'asc' },
  })
  const names = []
  const seen = new Set()
  for (const e of entries) {
    const n = e.horseName?.trim()
    if (n && !seen.has(n)) { seen.add(n); names.push(n) }
  }
  if (refetch) return names
  const have = new Set(
    (await prisma.horseStat.findMany({ where: { horseName: { in: names }, sire: { not: null } }, select: { horseName: true } })).map(h => h.horseName)
  )
  return names.filter(n => !have.has(n))
}

// 優先順位付きで血統未取得の馬名リストを取得
async function getPrioritizedHorses(refetch) {
  const now = new Date()
  // ①未来レース出走馬, ②重賞出走馬名（過去含む）, ③最近の出走馬, は raceEntry/result から
  const futureHorses = await prisma.raceEntry.findMany({
    where: { race: { date: { gte: now } } },
    select: { horseName: true }, distinct: ['horseName'],
  })
  const gradedHorses = await prisma.raceResult.findMany({
    where: { race: { grade: { in: ['G1', 'G2', 'G3'] } } },
    select: { horseName: true }, distinct: ['horseName'],
  })
  const priority = []
  const seen = new Set()
  for (const list of [futureHorses, gradedHorses]) {
    for (const e of list) {
      const n = e.horseName?.trim()
      if (n && !seen.has(n)) { seen.add(n); priority.push(n) }
    }
  }
  // 既に血統がある馬を除外（refetch 時は除外しない）
  const have = refetch ? new Set() : new Set(
    (await prisma.horseStat.findMany({ where: { sire: { not: null } }, select: { horseName: true } })).map(h => h.horseName)
  )
  // HorseStat に存在する全馬（最後にその他を回す）
  const allStats = await prisma.horseStat.findMany({ select: { horseName: true }, orderBy: { totalRaces: 'desc' } })
  for (const s of allStats) {
    const n = s.horseName?.trim()
    if (n && !seen.has(n)) { seen.add(n); priority.push(n) }
  }
  return priority.filter(n => !have.has(n))
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]
  }))
  const delay = parseInt(args.delay) || 350
  const limit = args.limit ? parseInt(args.limit) : Infinity
  const refetch = !!args.refetch

  console.log('=== 血統取得開始 ===')
  const raceId = typeof args.race === 'string' ? args.race : null
  const horses = raceId
    ? await getRaceHorses(raceId, refetch)
    : await getPrioritizedHorses(refetch)
  const target = horses.slice(0, limit)
  console.log(raceId
    ? `対象: レース ${raceId} の未取得 ${target.length} 頭 (delay=${delay}ms)`
    : `対象: ${target.length} 頭 (全未取得 ${horses.length} / delay=${delay}ms)`)

  let ok = 0, miss = 0, done = 0
  for (const name of target) {
    done++
    try {
      const id = await resolveHorseId(name)
      if (!id) { miss++; await sleep(delay); continue }
      const html = await fetchEucJp(`https://db.netkeiba.com/horse/ped/${id}/`)
      const ped = html ? parsePed(html) : null
      if (!ped) { miss++; await sleep(delay); continue }
      // HorseStat が無い馬もあり得る（未来レースのみ出走）→ upsert
      await prisma.horseStat.upsert({
        where: { horseName: name },
        update: ped,
        create: { horseName: name, ...ped },
      })
      ok++
    } catch (e) {
      miss++
    }
    if (done % 25 === 0) process.stdout.write(`  進捗 ${done}/${target.length}  取得${ok} 失敗${miss}\r`)
    await sleep(delay)
  }
  console.log(`\n=== 完了: 取得 ${ok} / 失敗 ${miss} / 計 ${done} 頭 ===`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
