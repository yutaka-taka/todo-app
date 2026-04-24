'use strict'
// 残りの2025年レース結果を個別に取得
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

async function main() {
  console.log('=== 残り2025年レース個別取得 ===\n')

  const noResultRaces = await prisma.race.findMany({
    where: { date: { lt: new Date('2025-08-01') }, results: { none: {} } },
    orderBy: { date: 'asc' },
  })
  console.log(`残り${noResultRaces.length}レース\n`)

  let seeded = 0
  // 1レースずつ丁寧に取得
  for (const race of noResultRaces) {
    const raceInfo = `${race.name}（${race.date.toISOString().slice(0,10)}、${race.venue}、${race.surface}、${race.distance}m、${race.grade}）`

    const prompt = `2025年のJRAレースの結果と出走馬を教えてください。

対象レース: ${raceInfo}

JSON形式のみ:
{
  "results": [
    {"finishPosition": 1, "horseName": "馬名"},
    {"finishPosition": 2, "horseName": "馬名"},
    {"finishPosition": 3, "horseName": "馬名"},
    {"finishPosition": 4, "horseName": "馬名"},
    {"finishPosition": 5, "horseName": "馬名"}
  ],
  "entries": [
    {"horseNumber": 1, "horseName": "馬名", "jockey": "騎手名", "age": 5},
    {"horseNumber": 2, "horseName": "馬名", "jockey": "騎手名", "age": 4}
  ]
}

出走馬は全頭（10〜18頭程度）を含めてください。このレースの結果を正確に知っている場合のみ回答してください。知らない場合は {"results": [], "entries": []} と回答してください。`

    try {
      const text = await callClaude(prompt, 'JRA競馬専門家。2025年の実際のレース結果を正確にJSON形式で回答。知らない場合は空配列。', 3000)
      const parsed = JSON.parse(extractJSON(text))

      if (!Array.isArray(parsed.results) || parsed.results.length < 2) {
        console.log(`  スキップ: ${race.name}（データなし）`)
        await sleep(300)
        continue
      }

      // エントリー保存
      let entrySaved = 0
      const existingEntries = await prisma.raceEntry.count({ where: { raceId: race.id } })
      if (existingEntries === 0 && Array.isArray(parsed.entries) && parsed.entries.length >= 5) {
        for (const e of parsed.entries) {
          if (!e.horseName || !e.horseNumber) continue
          try {
            await prisma.raceEntry.create({
              data: {
                raceId: race.id,
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
      for (const res of parsed.results.slice(0, 5)) {
        if (!res.horseName) continue
        const hn = parsed.entries?.find(e => e.horseName === res.horseName)?.horseNumber ?? (90 + res.finishPosition)
        try {
          await prisma.raceResult.create({
            data: {
              raceId: race.id,
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
        const top2 = parsed.results.slice(0,2).map(r=>r.horseName).join('/')
        console.log(`  ✓ ${race.name}: [${top2}] 出走${entrySaved}頭`)
      }
    } catch (e) {
      console.log(`  エラー: ${race.name} - ${String(e).slice(0,60)}`)
    }
    await sleep(400)
  }

  console.log(`\n取得完了: ${seeded}/${noResultRaces.length}レース`)

  if (seeded > 0) {
    // HorseStat全体更新
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
