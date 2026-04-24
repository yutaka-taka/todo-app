'use strict'
// 2016年・2017年のG1/G2/G3レース結果をClaudeから取得してDBに追加
const { PrismaClient } = require('@prisma/client')
const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs'), path = require('path')

function loadEnv(file) {
  try {
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^=#\s][^=]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    })
  } catch {}
}
loadEnv('.env'); loadEnv('.env.local')

const prisma = new PrismaClient()
const client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY })

function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) return m[1].trim()
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s !== -1 && e > s) return text.slice(s, e + 1)
  return text
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function callClaude(prompt, system, maxTokens = 4096) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
}

// 2016年・2017年のレーススケジュール
const raceSchedule = [
  // ===== 2016年 G1 (大阪杯はこの年G2) =====
  { name: 'フェブラリーステークス2016', date: new Date('2016-02-21'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2016', date: new Date('2016-03-27'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '桜花賞2016', date: new Date('2016-04-10'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2016', date: new Date('2016-04-17'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2016', date: new Date('2016-05-01'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2016', date: new Date('2016-05-08'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2016', date: new Date('2016-05-15'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2016', date: new Date('2016-05-22'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2016', date: new Date('2016-05-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2016', date: new Date('2016-06-05'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2016', date: new Date('2016-06-26'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2016', date: new Date('2016-10-02'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2016', date: new Date('2016-10-16'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2016', date: new Date('2016-10-23'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2016', date: new Date('2016-10-30'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2016', date: new Date('2016-11-13'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2016', date: new Date('2016-11-20'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2016', date: new Date('2016-11-27'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2016', date: new Date('2016-12-04'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2016', date: new Date('2016-12-11'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2016', date: new Date('2016-12-18'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2016', date: new Date('2016-12-25'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  // 2016年 主要G2
  { name: '大阪杯2016', date: new Date('2016-04-03'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'ホープフルステークス2016', date: new Date('2016-12-28'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '京都記念2016', date: new Date('2016-02-14'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2016', date: new Date('2016-02-28'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2016', date: new Date('2016-03-12'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '弥生賞2016', date: new Date('2016-03-06'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2016', date: new Date('2016-03-19'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '青葉賞2016', date: new Date('2016-04-30'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2016', date: new Date('2016-05-29'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'セントライト記念2016', date: new Date('2016-09-19'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2016', date: new Date('2016-09-25'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'オールカマー2016', date: new Date('2016-09-25'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2016', date: new Date('2016-10-09'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2016', date: new Date('2016-10-09'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'アルゼンチン共和国杯2016', date: new Date('2016-11-06'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },

  // ===== 2017年 G1 (大阪杯・ホープフルSがG1に昇格) =====
  { name: 'フェブラリーステークス2017', date: new Date('2017-02-19'), venue: '東京', grade: 'G1', surface: 'ダート', distance: 1600 },
  { name: '高松宮記念2017', date: new Date('2017-03-26'), venue: '中京', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '大阪杯2017', date: new Date('2017-04-02'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '桜花賞2017', date: new Date('2017-04-09'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '皐月賞2017', date: new Date('2017-04-16'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '天皇賞（春）2017', date: new Date('2017-04-30'), venue: '京都', grade: 'G1', surface: '芝', distance: 3200 },
  { name: 'NHKマイルカップ2017', date: new Date('2017-05-07'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ヴィクトリアマイル2017', date: new Date('2017-05-14'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'オークス2017', date: new Date('2017-05-21'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '日本ダービー2017', date: new Date('2017-05-28'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: '安田記念2017', date: new Date('2017-06-04'), venue: '東京', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '宝塚記念2017', date: new Date('2017-06-25'), venue: '阪神', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'スプリンターズステークス2017', date: new Date('2017-10-01'), venue: '中山', grade: 'G1', surface: '芝', distance: 1200 },
  { name: '秋華賞2017', date: new Date('2017-10-15'), venue: '京都', grade: 'G1', surface: '芝', distance: 2000 },
  { name: '菊花賞2017', date: new Date('2017-10-22'), venue: '京都', grade: 'G1', surface: '芝', distance: 3000 },
  { name: '天皇賞（秋）2017', date: new Date('2017-10-29'), venue: '東京', grade: 'G1', surface: '芝', distance: 2000 },
  { name: 'エリザベス女王杯2017', date: new Date('2017-11-12'), venue: '京都', grade: 'G1', surface: '芝', distance: 2200 },
  { name: 'マイルチャンピオンシップ2017', date: new Date('2017-11-19'), venue: '京都', grade: 'G1', surface: '芝', distance: 1600 },
  { name: 'ジャパンカップ2017', date: new Date('2017-11-26'), venue: '東京', grade: 'G1', surface: '芝', distance: 2400 },
  { name: 'チャンピオンズカップ2017', date: new Date('2017-12-03'), venue: '中京', grade: 'G1', surface: 'ダート', distance: 1800 },
  { name: '阪神ジュベナイルフィリーズ2017', date: new Date('2017-12-10'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '朝日杯フューチュリティステークス2017', date: new Date('2017-12-17'), venue: '阪神', grade: 'G1', surface: '芝', distance: 1600 },
  { name: '有馬記念2017', date: new Date('2017-12-24'), venue: '中山', grade: 'G1', surface: '芝', distance: 2500 },
  { name: 'ホープフルステークス2017', date: new Date('2017-12-28'), venue: '中山', grade: 'G1', surface: '芝', distance: 2000 },
  // 2017年 主要G2
  { name: '京都記念2017', date: new Date('2017-02-12'), venue: '京都', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '中山記念2017', date: new Date('2017-02-26'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '金鯱賞2017', date: new Date('2017-03-12'), venue: '中京', grade: 'G2', surface: '芝', distance: 2000 },
  { name: '弥生賞2017', date: new Date('2017-03-05'), venue: '中山', grade: 'G2', surface: '芝', distance: 2000 },
  { name: 'スプリングステークス2017', date: new Date('2017-03-19'), venue: '中山', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '青葉賞2017', date: new Date('2017-04-29'), venue: '東京', grade: 'G2', surface: '芝', distance: 2400 },
  { name: '目黒記念2017', date: new Date('2017-05-28'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
  { name: 'セントライト記念2017', date: new Date('2017-09-18'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '神戸新聞杯2017', date: new Date('2017-09-24'), venue: '阪神', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'オールカマー2017', date: new Date('2017-09-24'), venue: '中山', grade: 'G2', surface: '芝', distance: 2200 },
  { name: '毎日王冠2017', date: new Date('2017-10-08'), venue: '東京', grade: 'G2', surface: '芝', distance: 1800 },
  { name: '京都大賞典2017', date: new Date('2017-10-08'), venue: '京都', grade: 'G2', surface: '芝', distance: 2400 },
  { name: 'アルゼンチン共和国杯2017', date: new Date('2017-11-05'), venue: '東京', grade: 'G2', surface: '芝', distance: 2500 },
]

async function main() {
  console.log('=== 2016年・2017年レースデータ追加 ===\n')

  // 既存レースとの重複チェック
  const existingNames = new Set(
    (await prisma.race.findMany({ select: { name: true } })).map(r => r.name)
  )
  const newRaces = raceSchedule.filter(r => !existingNames.has(r.name))
  console.log(`追加対象: ${newRaces.length}件（既存: ${existingNames.size}件）`)

  // レース登録
  if (newRaces.length > 0) {
    await prisma.race.createMany({ data: newRaces, skipDuplicates: true })
    console.log(`レース登録完了: ${newRaces.length}件\n`)
  }

  // 結果のないレースに対してClaudeから結果取得
  const noResultRaces = await prisma.race.findMany({
    where: {
      date: { gte: new Date('2016-01-01'), lt: new Date('2018-01-01') },
      results: { none: {} },
    },
    orderBy: { date: 'asc' },
  })
  console.log(`結果取得対象: ${noResultRaces.length}件\n`)

  const BATCH = 5
  let seeded = 0

  for (let i = 0; i < noResultRaces.length; i += BATCH) {
    const batch = noResultRaces.slice(i, i + BATCH)
    const raceList = batch.map(r =>
      `${r.name}（${r.date.toISOString().slice(0,10)}、${r.venue}、${r.surface}${r.distance}m、${r.grade}）`
    ).join('\n')

    const prompt = `以下のJRAレース（2016年または2017年）の着順上位5頭と出走全馬を教えてください。

${raceList}

JSON形式のみで回答:
{"races":[
  {
    "raceName":"有馬記念2016",
    "results":[
      {"finishPosition":1,"horseName":"馬名"},
      {"finishPosition":2,"horseName":"馬名"},
      {"finishPosition":3,"horseName":"馬名"},
      {"finishPosition":4,"horseName":"馬名"},
      {"finishPosition":5,"horseName":"馬名"}
    ],
    "entries":[
      {"horseNumber":1,"horseName":"馬名","jockey":"騎手名","age":5},
      {"horseNumber":2,"horseName":"馬名","jockey":"騎手名","age":4}
    ]
  }
]}

知っているレースのみ回答。出走馬は全頭（10〜18頭程度）を含めてください。`

    try {
      const text = await callClaude(prompt, 'JRA競馬専門家。2016年・2017年の実際のレース結果を正確にJSON形式で回答。', 4096)
      const parsed = JSON.parse(extractJSON(text))
      if (!Array.isArray(parsed.races)) { console.log(`バッチ${Math.floor(i/BATCH)+1}: racesなし`); continue }

      for (const rd of parsed.races) {
        const matched = batch.find(r =>
          r.name === rd.raceName ||
          r.name.replace(/\d{4}$/, '').trim() === rd.raceName.replace(/\d{4}$/, '').trim() ||
          rd.raceName.includes(r.name.replace(/\d{4}$/, '').trim())
        )
        if (!matched) continue
        if (!Array.isArray(rd.results) || rd.results.length < 2) continue

        // エントリー保存
        const existingEntries = await prisma.raceEntry.count({ where: { raceId: matched.id } })
        let entrySaved = 0
        if (existingEntries === 0 && Array.isArray(rd.entries) && rd.entries.length >= 5) {
          for (const e of rd.entries) {
            if (!e.horseName || !e.horseNumber) continue
            try {
              await prisma.raceEntry.create({
                data: {
                  raceId: matched.id,
                  horseNumber: Number(e.horseNumber),
                  horseName: String(e.horseName).trim(),
                  jockey: e.jockey ? String(e.jockey).trim() : null,
                  age: e.age ? Number(e.age) : null,
                }
              })
              entrySaved++
            } catch {}
          }
        }

        // 結果保存
        let resultSaved = 0
        for (const res of rd.results.slice(0, 5)) {
          if (!res.horseName) continue
          const hn = rd.entries?.find(e => e.horseName === res.horseName)?.horseNumber ?? (90 + res.finishPosition)
          try {
            await prisma.raceResult.create({
              data: {
                raceId: matched.id,
                finishPosition: Number(res.finishPosition),
                horseNumber: Number(hn),
                horseName: String(res.horseName).trim(),
              }
            })
            resultSaved++
          } catch {}
        }

        if (resultSaved >= 2) {
          seeded++
          const top2 = rd.results.slice(0,2).map(r=>r.horseName).join('/')
          console.log(`  ✓ ${matched.name}: [${top2}] 出走${entrySaved}頭`)
        }
      }
    } catch (e) {
      console.log(`  バッチ${Math.floor(i/BATCH)+1}エラー: ${String(e).slice(0,80)}`)
    }
    await sleep(500)
  }

  console.log(`\n取得完了: ${seeded}/${noResultRaces.length}レース`)

  // HorseStat全体更新
  if (seeded > 0) {
    console.log('\nHorseStat全体更新中...')
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
          statsMap.set(res.horseName, {
            totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
            distanceData: {}, venueData: {}, surfaceData: {}, lastRaceDate: r.date
          })
        }
        const s = statsMap.get(res.horseName)
        s.totalRaces++; if (placed) s.totalPlaces++
        if (r.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
        const dk = String(r.distance)
        if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
        s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
        if (!s.venueData[r.venue]) s.venueData[r.venue] = { races: 0, places: 0 }
        s.venueData[r.venue].races++; if (placed) s.venueData[r.venue].places++
        if (!s.surfaceData[r.surface]) s.surfaceData[r.surface] = { races: 0, places: 0 }
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

    let horseUpdated = 0
    for (const [horseName, hs] of statsMap) {
      try {
        const existing = await prisma.horseStat.findUnique({ where: { horseName } })
        if (existing) {
          await prisma.horseStat.update({
            where: { horseName },
            data: {
              totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races, g1Places: hs.g1Places,
              distanceData: hs.distanceData, venueData: hs.venueData, surfaceData: hs.surfaceData,
              recentForm: hs.recentForm || null,
              lastRaceDate: hs.lastRaceDate > (existing.lastRaceDate || new Date(0)) ? hs.lastRaceDate : existing.lastRaceDate,
            }
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName, totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races, g1Places: hs.g1Places,
              distanceData: hs.distanceData, venueData: hs.venueData, surfaceData: hs.surfaceData,
              lastRaceDate: hs.lastRaceDate, recentForm: hs.recentForm || null,
            }
          })
        }
        horseUpdated++
      } catch {}
    }
    console.log(`HorseStat更新: ${horseUpdated}頭`)
  }

  console.log('\n=== 完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('エラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
