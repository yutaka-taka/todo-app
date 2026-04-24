'use strict'
// 2025年G1・G2/G3レース結果をClaudeから取得してDBに追加
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

async function callClaude(prompt, system, maxTokens = 3000) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
}

async function main() {
  console.log('=== 2025年レース結果・出走馬データ取得 ===\n')

  // 結果なし過去レースを全取得
  const cutoff = new Date('2025-08-01')
  const noResultRaces = await prisma.race.findMany({
    where: { date: { lt: cutoff }, results: { none: {} } },
    orderBy: { date: 'asc' },
  })
  console.log(`結果なしレース数: ${noResultRaces.length}`)

  // G1を優先、その後G2/G3
  const g1Races = noResultRaces.filter(r => r.grade === 'G1')
  const g2g3Races = noResultRaces.filter(r => r.grade !== 'G1').slice(0, 60)
  const targetRaces = [...g1Races, ...g2g3Races]
  console.log(`取得対象: G1=${g1Races.length}件 G2/G3=${g2g3Races.length}件\n`)

  const BATCH = 6
  let seeded = 0

  for (let i = 0; i < targetRaces.length; i += BATCH) {
    const batch = targetRaces.slice(i, i + BATCH)
    const raceList = batch.map(r => `${r.name}（${r.date.toISOString().slice(0,10)}、${r.venue}、${r.surface}${r.distance}m、${r.grade}）`).join('\n')

    // 結果と出走馬を同時取得
    const prompt = `以下のJRAレースについて、着順上位5頭と出走全馬（10〜18頭）を教えてください。

${raceList}

JSON形式のみで回答:
{"races":[
  {
    "raceName":"宝塚記念2025",
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

知っているレースのみ回答してください。`

    try {
      const text = await callClaude(prompt, 'JRA競馬専門家。過去レースの着順と出走馬をJSON形式で正確に回答。知らないレースはskip。', 4096)
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

        // エントリー保存（なければ）
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
          console.log(`  ✓ ${matched.name}: 結果${resultSaved}件、出走${entrySaved}頭`)
        }
      }
    } catch (e) {
      console.log(`  バッチ${Math.floor(i/BATCH)+1}エラー: ${String(e).slice(0,80)}`)
    }
    await sleep(600)
  }

  console.log(`\n取得完了: ${seeded}レース`)

  // HorseStat一括更新（全結果から）
  console.log('\nHorseStat更新中...')
  const allResultRaces = await prisma.race.findMany({
    where: { results: { some: {} } },
    include: { results: { orderBy: { finishPosition: 'asc' } } },
    orderBy: { date: 'asc' },
  })

  const statsMap = new Map()
  const finishesMap = new Map()

  for (const race of allResultRaces) {
    for (const res of race.results) {
      if (!res.horseName?.trim()) continue
      const placed = res.finishPosition <= 2
      if (!statsMap.has(res.horseName)) {
        statsMap.set(res.horseName, {
          totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, lastRaceDate: race.date
        })
      }
      const s = statsMap.get(res.horseName)
      s.totalRaces++
      if (placed) s.totalPlaces++
      if (race.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
      const dk = String(race.distance)
      if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
      s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
      if (!s.venueData[race.venue]) s.venueData[race.venue] = { races: 0, places: 0 }
      s.venueData[race.venue].races++; if (placed) s.venueData[race.venue].places++
      if (!s.surfaceData[race.surface]) s.surfaceData[race.surface] = { races: 0, places: 0 }
      s.surfaceData[race.surface].races++; if (placed) s.surfaceData[race.surface].places++
      if (race.date > s.lastRaceDate) s.lastRaceDate = race.date
      if (!finishesMap.has(res.horseName)) finishesMap.set(res.horseName, [])
      finishesMap.get(res.horseName).push({ date: race.date.getTime(), position: res.finishPosition })
    }
  }

  finishesMap.forEach((finishes, horseName) => {
    const s = statsMap.get(horseName)
    if (!s) return
    finishes.sort((a, b) => b.date - a.date)
    s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
  })

  function mergeData(ex, inc) {
    const m = { ...ex }
    for (const [k, v] of Object.entries(inc)) {
      m[k] = m[k] ? { races: m[k].races + v.races, places: m[k].places + v.places } : { ...v }
    }
    return m
  }

  let horseUpdated = 0
  for (const [horseName, hs] of statsMap) {
    try {
      const existing = await prisma.horseStat.findUnique({ where: { horseName } })
      if (existing) {
        await prisma.horseStat.update({
          where: { horseName },
          data: {
            totalRaces: hs.totalRaces,
            totalPlaces: hs.totalPlaces,
            g1Races: hs.g1Races,
            g1Places: hs.g1Places,
            distanceData: mergeData(existing.distanceData, hs.distanceData),
            venueData: mergeData(existing.venueData, hs.venueData),
            surfaceData: mergeData(existing.surfaceData, hs.surfaceData),
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
  console.log('\n=== 完了 ===')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error('エラー:', e)
  await prisma.$disconnect()
  process.exit(1)
})
