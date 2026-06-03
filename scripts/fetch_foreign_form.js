'use strict'
/**
 * netkeiba から各馬の「全戦績（海外・地方を含む）」を取得し ml/foreign_form.json に保存する。
 *
 *   node scripts/fetch_foreign_form.js [--g1] [--names=a,b] [--limit=N] [--delay=400] [--refetch]
 *
 * 狙い: JRA戦績が無い/薄い「0戦海外馬」(カランダガン/ロマンチックウォリアー等)を可予測化する。
 *   本アプリは RaceResult(=JRA中心)から特徴量を作るため、海外G1勝ち馬でも「0戦＝評価不能」に
 *   なり top5/伏兵で射程外になる。netkeiba の result ページは海外戦績を含むので、これを
 *   point-in-time の事前 form として注入する（src/lib/foreignForm.ts が消費）。
 *
 * - 取得元: https://db.netkeiba.com/horse/result/{id}/ （静的EUC-JP・無料。/horse/{id}/ 本体はJS化済）
 * - 馬ID: RaceResult.netkeibaHorseId を優先利用、無ければ馬名検索で解決。
 * - resumable: 既に foreign_form.json にある馬はスキップ（--refetch で再取得）。
 * - 優先順位: ①未来レース出走馬 ②重賞(特にG1)出走馬 ③その他。途中停止でも「予想したい馬」から埋まる。
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')

function loadEnv(f) {
  try {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach((l) => {
      const m = l.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()
const OUT = path.join(__dirname, '..', 'ml', 'foreign_form.json')
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  Referer: 'https://db.netkeiba.com/',
}
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]
}))
const DELAY = Number(argv.delay ?? 400)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const JRA_VENUES = ['東京', '中山', '阪神', '京都', '中京', '新潟', '札幌', '函館', '小倉', '福島']
const GRADE_MAP = (token) => {
  if (!token) return '通常'
  const t = token.replace(/[（）()]/g, '').replace(/J\./i, '')
  if (/^G?I{3}$|^G3$|GⅢ|GIII/.test(t)) return 'G3'
  if (/^G?II$|^G2$|GⅡ|GII/.test(t)) return 'G2'
  if (/^G?I$|^G1$|GⅠ|GI/.test(t)) return 'G1'
  return '通常'
}

async function fetchEucJp(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS })
      if (!res.ok) { await sleep(500 * (i + 1)); continue }
      return new TextDecoder('euc-jp').decode(await res.arrayBuffer())
    } catch { await sleep(500 * (i + 1)) }
  }
  return null
}

async function resolveHorseId(name) {
  const html = await fetchEucJp(`https://db.netkeiba.com/?pid=horse_list&word=${encodeURIComponent(name)}&match=partial_match`)
  if (!html) return null
  const pairs = [...html.matchAll(/\/horse\/(\d{10})\/"[^>]*>([^<]+)</g)].map((m) => ({ id: m[1], name: m[2].trim() }))
  if (pairs.length === 0) return null
  return (pairs.find((p) => p.name === name) ?? pairs[0]).id
}

// result ページHTML → 戦績配列 [{date, grade, pos, field, overseas, venue, name}]
function parseResults(html) {
  const tbl = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i)
  if (!tbl) return []
  const out = []
  for (const row of [...tbl[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]) {
    const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    if (tds.length < 12) continue
    const date = tds[0]
    if (!/^20\d\d\/\d\d?\/\d\d?$/.test(date)) continue
    const kaisai = tds[1]          // 例 "2東京12" / "メイダン" / "大井"
    const raceName = tds[4]        // 例 "東京優駿(GI)"
    const field = parseInt(tds[6], 10) || null
    const pos = parseInt(tds[11], 10) || null
    const gradeTok = raceName.match(/\(([^)]*G[^)]*)\)|（([^）]*G[^）]*)）/)
    const grade = GRADE_MAP(gradeTok ? (gradeTok[1] || gradeTok[2]) : '')
    const venue = kaisai.replace(/^\d+/, '').replace(/\d+$/, '') || kaisai
    const overseas = !JRA_VENUES.some((v) => kaisai.includes(v))
    out.push({ date: date.replace(/\//g, '-'), grade, pos, field, overseas, venue, name: raceName.replace(/\([^)]*\)/g, '').trim() })
  }
  return out
}

async function main() {
  const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
  const before = Object.keys(store).length

  // 対象馬の収集（優先順位つき）
  const targets = new Map() // name -> netkeibaHorseId|null
  const addRows = (rows) => rows.forEach((r) => { if (r.horseName && !targets.has(r.horseName)) targets.set(r.horseName, r.netkeibaHorseId ?? null) })

  if (argv.names) {
    String(argv.names).split(',').forEach((n) => targets.set(n.trim(), null))
  } else {
    // ① 未来レース出走馬（予想対象）
    addRows(await prisma.raceEntry.findMany({
      where: { race: { date: { gte: new Date() } } },
      select: { horseName: true }, take: 5000,
    }).then((rs) => rs.map((r) => ({ horseName: r.horseName, netkeibaHorseId: null }))))
    // ② G1 出走馬（検証対象＝0戦海外馬が混じる）。--g1 でこれだけに絞ることも可。
    addRows(await prisma.raceResult.findMany({
      where: { race: { grade: 'G1', date: { gte: new Date('2023-01-01') } } },
      select: { horseName: true, netkeibaHorseId: true },
    }))
    if (!argv.g1) {
      // ③ その他の重賞出走馬
      addRows(await prisma.raceResult.findMany({
        where: { race: { grade: { in: ['G2', 'G3'] }, date: { gte: new Date('2023-01-01') } } },
        select: { horseName: true, netkeibaHorseId: true }, take: 8000,
      }))
    }
  }

  let list = [...targets.entries()].filter(([name]) => argv.refetch || !store[name])
  if (argv.limit) list = list.slice(0, Number(argv.limit))
  console.log(`[foreign] 対象 ${targets.size} 頭 / 未取得 ${list.length} 頭（既存 ${before}）/ delay=${DELAY}ms`)

  let done = 0, hit = 0, save = 0
  for (const [name, cachedId] of list) {
    done++
    let id = cachedId
    if (!id) { id = await resolveHorseId(name); await sleep(DELAY) }
    if (!id) { store[name] = { id: null, races: [], scrapedAt: new Date().toISOString() }; continue }
    const html = await fetchEucJp(`https://db.netkeiba.com/horse/result/${id}/`)
    await sleep(DELAY)
    const races = html ? parseResults(html) : []
    store[name] = { id, races, scrapedAt: new Date().toISOString() }
    if (races.length) hit++
    if (races.some((r) => r.overseas)) save++
    if (done % 25 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(store))
      console.log(`  ${done}/${list.length}  最新: ${name} 戦${races.length}(海外${races.filter((r) => r.overseas).length})`)
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(store))
  console.log(`[foreign] 完了: 取得${done} / 戦績あり${hit} / 海外実績あり${save} / 総計${Object.keys(store).length}頭 → ${OUT}`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
