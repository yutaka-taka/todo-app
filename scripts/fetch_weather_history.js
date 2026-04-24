'use strict'
/**
 * 過去G1レースの天候・馬場状態をOpenMeteo Archive APIから取得し
 * Race.trackConditionに保存する
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname,'..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()

const VENUE_COORDS = {
  '東京':   { lat: 35.7378, lon: 139.5022 },
  '中山':   { lat: 35.7773, lon: 139.9267 },
  '阪神':   { lat: 34.8259, lon: 135.3501 },
  '京都':   { lat: 34.9035, lon: 135.7733 },
  '中京':   { lat: 35.1162, lon: 136.9235 },
  '福島':   { lat: 37.7249, lon: 140.4770 },
  '新潟':   { lat: 37.8201, lon: 138.9942 },
  '函館':   { lat: 41.8269, lon: 140.7395 },
  '札幌':   { lat: 43.0445, lon: 141.3694 },
  '小倉':   { lat: 33.8810, lon: 130.8797 },
}

function precipToCondition(precipMm, weatherCode) {
  // WMO weather codes: 0-3=clear, 51-67=drizzle/rain, 71-77=snow, 80-82=showers
  const isRainy = (weatherCode >= 51 && weatherCode <= 82)
  if (!isRainy && precipMm < 0.1) return '良'
  if (precipMm < 1.5) return '稍重'
  if (precipMm < 5.0) return '重'
  return '不良'
}

async function fetchWeatherForDate(lat, lon, dateStr) {
  // dateStr: "YYYY-MM-DD"
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&hourly=precipitation,weathercode&timezone=Asia%2FTokyo`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()

  // Find the hour closest to 15:00 (main race time in JST)
  const hours = data.hourly?.time ?? []
  const precipArr = data.hourly?.precipitation ?? []
  const codeArr = data.hourly?.weathercode ?? []

  // Look at 12:00-17:00 window (typically 3-4 main races in this range)
  const windowPrecip = []
  const windowCodes = []
  for (let i = 0; i < hours.length; i++) {
    const h = new Date(hours[i]).getHours()
    if (h >= 10 && h <= 17) {
      windowPrecip.push(precipArr[i] ?? 0)
      windowCodes.push(codeArr[i] ?? 0)
    }
  }

  const totalPrecip = windowPrecip.reduce((a, b) => a + b, 0)
  const maxCode = windowCodes.length > 0 ? Math.max(...windowCodes) : 0

  return precipToCondition(totalPrecip, maxCode)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('=== 過去G1レース 天気・馬場状態取得 ===\n')

  const races = await prisma.race.findMany({
    where: { grade: 'G1' },
    orderBy: { date: 'asc' },
    select: { id: true, name: true, date: true, venue: true, trackCondition: true },
  })

  console.log(`対象レース数: ${races.length}`)
  const needFetch = races.filter(r => !r.trackCondition)
  console.log(`未取得: ${needFetch.length}`)

  let fetched = 0, failed = 0, skipped = 0
  const conditionCounts = {}

  for (const race of races) {
    if (race.trackCondition) {
      skipped++
      conditionCounts[race.trackCondition] = (conditionCounts[race.trackCondition] ?? 0) + 1
      continue
    }

    const coords = VENUE_COORDS[race.venue]
    if (!coords) {
      console.log(`  ⚠ 競馬場不明: ${race.venue} (${race.name})`)
      failed++
      continue
    }

    const dateStr = race.date.toISOString().split('T')[0]

    try {
      const cond = await fetchWeatherForDate(coords.lat, coords.lon, dateStr)
      await prisma.race.update({
        where: { id: race.id },
        data: { trackCondition: cond },
      })
      conditionCounts[cond] = (conditionCounts[cond] ?? 0) + 1
      process.stdout.write(`  ${race.name.padEnd(20)} ${dateStr}  → ${cond}\n`)
      fetched++
      await sleep(300) // rate limit
    } catch (e) {
      console.log(`  ✗ ${race.name} ${dateStr}: ${e.message}`)
      failed++
    }
  }

  console.log(`\n完了: 取得=${fetched}, スキップ=${skipped}, 失敗=${failed}`)
  console.log('馬場状態分布:', conditionCounts)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
