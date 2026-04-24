'use strict'
// 2014-2015年 G1/G2レース結果シード（Claude API使用・ラスト活用）
const { PrismaClient } = require('@prisma/client')
const Anthropic = require('@anthropic-ai/sdk')
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
const client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY })

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) return m[1].trim()
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s !== -1 && e > s) return text.slice(s, e + 1)
  return text
}

async function callClaude(prompt) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: 'JRA競馬専門家。指定レースの実際の結果と出走馬をJSON形式で正確に回答。不明な場合は空配列。',
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
}

// 2014年レース一覧
const races2014 = [
  // G1
  { name: 'フェブラリーステークス2014', date: '2014-02-23', venue: '東京', surface: 'ダート', distance: 1600, grade: 'G1' },
  { name: '高松宮記念2014', date: '2014-03-30', venue: '中京', surface: '芝', distance: 1200, grade: 'G1' },
  { name: '桜花賞2014', date: '2014-04-06', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '皐月賞2014', date: '2014-04-20', venue: '中山', surface: '芝', distance: 2000, grade: 'G1' },
  { name: '天皇賞（春）2014', date: '2014-05-04', venue: '京都', surface: '芝', distance: 3200, grade: 'G1' },
  { name: 'NHKマイルカップ2014', date: '2014-05-11', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: 'ヴィクトリアマイル2014', date: '2014-05-18', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '優駿牝馬（オークス）2014', date: '2014-05-25', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: '日本ダービー2014', date: '2014-06-01', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: '安田記念2014', date: '2014-06-08', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '宝塚記念2014', date: '2014-06-29', venue: '阪神', surface: '芝', distance: 2200, grade: 'G1' },
  { name: 'スプリンターズステークス2014', date: '2014-09-28', venue: '中山', surface: '芝', distance: 1200, grade: 'G1' },
  { name: '秋華賞2014', date: '2014-10-12', venue: '京都', surface: '芝', distance: 2000, grade: 'G1' },
  { name: '菊花賞2014', date: '2014-10-26', venue: '京都', surface: '芝', distance: 3000, grade: 'G1' },
  { name: '天皇賞（秋）2014', date: '2014-11-02', venue: '東京', surface: '芝', distance: 2000, grade: 'G1' },
  { name: 'エリザベス女王杯2014', date: '2014-11-09', venue: '京都', surface: '芝', distance: 2200, grade: 'G1' },
  { name: 'マイルチャンピオンシップ2014', date: '2014-11-23', venue: '京都', surface: '芝', distance: 1600, grade: 'G1' },
  { name: 'ジャパンカップ2014', date: '2014-11-30', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: 'チャンピオンズカップ2014', date: '2014-12-07', venue: '中京', surface: 'ダート', distance: 1800, grade: 'G1' },
  { name: '阪神ジュベナイルフィリーズ2014', date: '2014-12-14', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: 'ホープフルステークス2014', date: '2014-12-27', venue: '中山', surface: '芝', distance: 2000, grade: 'G2' },
  { name: '朝日杯フューチュリティステークス2014', date: '2014-12-21', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '有馬記念2014', date: '2014-12-28', venue: '中山', surface: '芝', distance: 2500, grade: 'G1' },
  // G2
  { name: '中山記念2014', date: '2014-03-02', venue: '中山', surface: '芝', distance: 1800, grade: 'G2' },
  { name: '阪神大賞典2014', date: '2014-03-23', venue: '阪神', surface: '芝', distance: 3000, grade: 'G2' },
  { name: '産経大阪杯2014', date: '2014-04-06', venue: '阪神', surface: '芝', distance: 2000, grade: 'G2' },
  { name: '青葉賞2014', date: '2014-05-03', venue: '東京', surface: '芝', distance: 2400, grade: 'G2' },
  { name: 'プリンシパルステークス2014', date: '2014-05-17', venue: '東京', surface: '芝', distance: 2000, grade: 'G3' },
  { name: '毎日王冠2014', date: '2014-10-05', venue: '東京', surface: '芝', distance: 1800, grade: 'G2' },
  { name: '富士ステークス2014', date: '2014-10-25', venue: '東京', surface: '芝', distance: 1600, grade: 'G2' },
  { name: 'アルゼンチン共和国杯2014', date: '2014-11-02', venue: '東京', surface: '芝', distance: 2500, grade: 'G2' },
  { name: '京阪杯2014', date: '2014-11-23', venue: '京都', surface: '芝', distance: 1200, grade: 'G2' },
]

// 2015年レース一覧
const races2015 = [
  // G1
  { name: 'フェブラリーステークス2015', date: '2015-02-22', venue: '東京', surface: 'ダート', distance: 1600, grade: 'G1' },
  { name: '高松宮記念2015', date: '2015-03-29', venue: '中京', surface: '芝', distance: 1200, grade: 'G1' },
  { name: '桜花賞2015', date: '2015-04-12', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '皐月賞2015', date: '2015-04-19', venue: '中山', surface: '芝', distance: 2000, grade: 'G1' },
  { name: '天皇賞（春）2015', date: '2015-05-03', venue: '京都', surface: '芝', distance: 3200, grade: 'G1' },
  { name: 'NHKマイルカップ2015', date: '2015-05-10', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: 'ヴィクトリアマイル2015', date: '2015-05-17', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '優駿牝馬（オークス）2015', date: '2015-05-24', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: '日本ダービー2015', date: '2015-05-31', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: '安田記念2015', date: '2015-06-07', venue: '東京', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '宝塚記念2015', date: '2015-06-28', venue: '阪神', surface: '芝', distance: 2200, grade: 'G1' },
  { name: 'スプリンターズステークス2015', date: '2015-10-04', venue: '中山', surface: '芝', distance: 1200, grade: 'G1' },
  { name: '秋華賞2015', date: '2015-10-18', venue: '京都', surface: '芝', distance: 2000, grade: 'G1' },
  { name: '菊花賞2015', date: '2015-10-25', venue: '京都', surface: '芝', distance: 3000, grade: 'G1' },
  { name: '天皇賞（秋）2015', date: '2015-11-01', venue: '東京', surface: '芝', distance: 2000, grade: 'G1' },
  { name: 'エリザベス女王杯2015', date: '2015-11-15', venue: '京都', surface: '芝', distance: 2200, grade: 'G1' },
  { name: 'マイルチャンピオンシップ2015', date: '2015-11-22', venue: '京都', surface: '芝', distance: 1600, grade: 'G1' },
  { name: 'ジャパンカップ2015', date: '2015-11-29', venue: '東京', surface: '芝', distance: 2400, grade: 'G1' },
  { name: 'チャンピオンズカップ2015', date: '2015-12-06', venue: '中京', surface: 'ダート', distance: 1800, grade: 'G1' },
  { name: '阪神ジュベナイルフィリーズ2015', date: '2015-12-13', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '朝日杯フューチュリティステークス2015', date: '2015-12-20', venue: '阪神', surface: '芝', distance: 1600, grade: 'G1' },
  { name: '有馬記念2015', date: '2015-12-27', venue: '中山', surface: '芝', distance: 2500, grade: 'G1' },
  // G2
  { name: '中山記念2015', date: '2015-03-01', venue: '中山', surface: '芝', distance: 1800, grade: 'G2' },
  { name: '阪神大賞典2015', date: '2015-03-22', venue: '阪神', surface: '芝', distance: 3000, grade: 'G2' },
  { name: '産経大阪杯2015', date: '2015-04-05', venue: '阪神', surface: '芝', distance: 2000, grade: 'G2' },
  { name: '毎日王冠2015', date: '2015-10-11', venue: '東京', surface: '芝', distance: 1800, grade: 'G2' },
  { name: '富士ステークス2015', date: '2015-10-24', venue: '東京', surface: '芝', distance: 1600, grade: 'G2' },
  { name: 'アルゼンチン共和国杯2015', date: '2015-11-08', venue: '東京', surface: '芝', distance: 2500, grade: 'G2' },
]

async function seedRace(raceData) {
  // 既存チェック
  const existing = await prisma.race.findFirst({ where: { name: raceData.name } })
  if (existing) {
    const resCount = await prisma.raceResult.count({ where: { raceId: existing.id } })
    if (resCount >= 2) return { status: 'skip', name: raceData.name }
  }

  const prompt = `${raceData.name}（${raceData.date}、${raceData.venue}、${raceData.surface}、${raceData.distance}m、${raceData.grade}）の実際のレース結果と出走馬を教えてください。

JSON形式のみで回答:
{
  "results": [
    {"finishPosition": 1, "horseName": "馬名"},
    {"finishPosition": 2, "horseName": "馬名"},
    {"finishPosition": 3, "horseName": "馬名"}
  ],
  "entries": [
    {"horseNumber": 1, "horseName": "馬名", "jockey": "騎手名", "age": 5},
    {"horseNumber": 2, "horseName": "馬名", "jockey": "騎手名", "age": 4}
  ]
}

出走馬は全頭含めてください。確実な情報がない場合は {"results": [], "entries": []} と回答。`

  try {
    const text = await callClaude(prompt)
    const parsed = JSON.parse(extractJSON(text))

    if (!Array.isArray(parsed.results) || parsed.results.length < 2) {
      return { status: 'no_data', name: raceData.name }
    }

    // レース作成/更新
    let race = existing
    if (!race) {
      race = await prisma.race.create({
        data: {
          name: raceData.name,
          date: new Date(raceData.date),
          venue: raceData.venue,
          surface: raceData.surface,
          distance: raceData.distance,
          grade: raceData.grade,
        }
      })
    }

    // エントリー保存
    let entrySaved = 0
    const existingEntries = await prisma.raceEntry.count({ where: { raceId: race.id } })
    if (existingEntries === 0 && Array.isArray(parsed.entries) && parsed.entries.length >= 5) {
      for (const e of parsed.entries) {
        if (!e.horseName || !e.horseNumber) continue
        try {
          await prisma.raceEntry.create({
            data: { raceId: race.id, horseNumber: Number(e.horseNumber), horseName: String(e.horseName).trim(), jockey: e.jockey ? String(e.jockey).trim() : null, age: e.age ? Number(e.age) : null }
          })
          entrySaved++
        } catch {}
      }
    }

    // 結果保存（重複チェック）
    let resultSaved = 0
    await prisma.raceResult.deleteMany({ where: { raceId: race.id } })
    const seenHorses = new Set()
    for (const res of parsed.results.slice(0, 5)) {
      if (!res.horseName || seenHorses.has(res.horseName)) continue
      seenHorses.add(res.horseName)
      const hn = parsed.entries?.find(e => e.horseName === res.horseName)?.horseNumber ?? (90 + res.finishPosition)
      try {
        await prisma.raceResult.create({
          data: { raceId: race.id, finishPosition: Number(res.finishPosition), horseNumber: Number(hn), horseName: String(res.horseName).trim() }
        })
        resultSaved++
      } catch {}
    }

    if (resultSaved >= 2) {
      const top2 = parsed.results.slice(0, 2).map(r => r.horseName).join('/')
      return { status: 'ok', name: raceData.name, top2, entries: entrySaved }
    }
    return { status: 'partial', name: raceData.name }
  } catch (e) {
    return { status: 'error', name: raceData.name, error: String(e).slice(0, 80) }
  }
}

async function rebuildHorseStat() {
  console.log('\nHorseStat再構築中...')
  const allResultRaces = await prisma.race.findMany({
    where: { results: { some: {} } },
    include: { results: { orderBy: { finishPosition: 'asc' } } },
    orderBy: { date: 'asc' },
  })
  const statsMap = new Map()
  const finishesMap = new Map()

  for (const r of allResultRaces) {
    for (const res of r.results) {
      if (!res.horseName?.trim()) continue
      const placed = res.finishPosition <= 2
      if (!statsMap.has(res.horseName)) {
        statsMap.set(res.horseName, { totalRaces:0, totalPlaces:0, g1Races:0, g1Places:0, distanceData:{}, venueData:{}, surfaceData:{}, lastRaceDate: r.date })
      }
      const s = statsMap.get(res.horseName)
      s.totalRaces++; if (placed) s.totalPlaces++
      if (r.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
      const dk = String(r.distance)
      if (!s.distanceData[dk]) s.distanceData[dk] = { races:0, places:0 }
      s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
      if (!s.venueData[r.venue]) s.venueData[r.venue] = { races:0, places:0 }
      s.venueData[r.venue].races++; if (placed) s.venueData[r.venue].places++
      if (!s.surfaceData[r.surface]) s.surfaceData[r.surface] = { races:0, places:0 }
      s.surfaceData[r.surface].races++; if (placed) s.surfaceData[r.surface].places++
      if (r.date > s.lastRaceDate) s.lastRaceDate = r.date
      if (!finishesMap.has(res.horseName)) finishesMap.set(res.horseName, [])
      finishesMap.get(res.horseName).push({ date: r.date.getTime(), position: res.finishPosition })
    }
  }
  finishesMap.forEach((finishes, name) => {
    const s = statsMap.get(name); if (!s) return
    finishes.sort((a, b) => b.date - a.date)
    s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
  })

  await prisma.horseStat.deleteMany({})
  let created = 0
  for (const [horseName, hs] of statsMap) {
    try {
      await prisma.horseStat.create({
        data: { horseName, totalRaces:hs.totalRaces, totalPlaces:hs.totalPlaces, g1Races:hs.g1Races, g1Places:hs.g1Places, distanceData:hs.distanceData, venueData:hs.venueData, surfaceData:hs.surfaceData, lastRaceDate:hs.lastRaceDate, recentForm:hs.recentForm||null }
      })
      created++
    } catch {}
  }
  console.log(`HorseStat再構築完了: ${created}頭`)
}

async function main() {
  console.log('=== 2014-2015年レースシード ===\n')

  const allRaces = [...races2014, ...races2015]
  let ok = 0, skip = 0, noData = 0, errors = 0

  for (const raceData of allRaces) {
    const result = await seedRace(raceData)
    if (result.status === 'ok') {
      ok++
      console.log(`  ✓ ${result.name}: [${result.top2}] ${result.entries}頭`)
    } else if (result.status === 'skip') {
      skip++
      console.log(`  - ${result.name}: 既存`)
    } else if (result.status === 'no_data') {
      noData++
      console.log(`  ? ${result.name}: データなし`)
    } else {
      errors++
      console.log(`  ✗ ${result.name}: ${result.error || result.status}`)
    }
    await sleep(500)
  }

  console.log(`\n完了: 取得=${ok}, スキップ=${skip}, データなし=${noData}, エラー=${errors}`)

  if (ok > 0) await rebuildHorseStat()

  console.log('\n=== シード完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
