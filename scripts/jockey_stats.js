'use strict'
/**
 * 騎手統計をRaceEntry+RaceResultから計算
 * RaceEntryに騎手名あり、RaceResultに着順あり → raceId+horseNumberで結合
 */
const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname,'..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()

async function computeJockeyStats() {
  const races = await prisma.race.findMany({
    include: {
      entries: { select: { horseNumber: true, horseName: true, jockey: true } },
      results: { select: { horseNumber: true, horseName: true, finishPosition: true } },
    },
  })

  const stats = new Map() // jockey → { total, places, g1Total, g1Places, turfTotal, turfPlaces, dirtTotal, dirtPlaces }

  for (const race of races) {
    // Build result lookup by horseNumber
    const resultByNum = new Map(race.results.map(r => [r.horseNumber, r]))
    const resultByName = new Map(race.results.map(r => [r.horseName, r]))

    for (const entry of race.entries) {
      if (!entry.jockey) continue
      const result = resultByNum.get(entry.horseNumber) ?? resultByName.get(entry.horseName)
      if (!result) continue

      const j = entry.jockey
      if (!stats.has(j)) stats.set(j, { total: 0, places: 0, g1Total: 0, g1Places: 0, turfTotal: 0, turfPlaces: 0, dirtTotal: 0, dirtPlaces: 0 })
      const s = stats.get(j)
      const placed = result.finishPosition <= 2
      s.total++
      if (placed) s.places++
      if (race.grade === 'G1') { s.g1Total++; if (placed) s.g1Places++ }
      if (race.surface === '芝') { s.turfTotal++; if (placed) s.turfPlaces++ }
      if (race.surface === 'ダート') { s.dirtTotal++; if (placed) s.dirtPlaces++ }
    }
  }

  return stats
}

async function main() {
  const stats = await computeJockeyStats()
  console.log('総騎手数:', stats.size)

  const sorted = [...stats.entries()]
    .filter(([, s]) => s.g1Total >= 5)
    .map(([j, s]) => ({
      jockey: j,
      total: s.total,
      placeRate: Math.round(s.places / s.total * 1000) / 10,
      g1Total: s.g1Total,
      g1PlaceRate: s.g1Total > 0 ? Math.round(s.g1Places / s.g1Total * 1000) / 10 : 0,
      turfRate: s.turfTotal > 0 ? Math.round(s.turfPlaces / s.turfTotal * 1000) / 10 : 0,
      dirtRate: s.dirtTotal > 0 ? Math.round(s.dirtPlaces / s.dirtTotal * 1000) / 10 : 0,
      g1Score: Math.round((s.g1Places + 1) / (s.g1Total + 4) * 100),
    }))
    .sort((a, b) => b.g1PlaceRate - a.g1PlaceRate)

  console.log('\n騎手名              | 全連対率 | G1出走 | G1連対率 | 芝連対率 | ダ連対率 | G1スコア')
  for (const s of sorted) {
    const pad = (s.jockey + '                ').slice(0, 16)
    console.log(`${pad} | ${String(s.placeRate+'%').padStart(7)} | ${String(s.g1Total).padStart(6)} | ${String(s.g1PlaceRate+'%').padStart(7)} | ${String(s.turfRate+'%').padStart(7)} | ${String(s.dirtRate+'%').padStart(7)} | ${s.g1Score}`)
  }

  // G1スコアから動的JOCKEYランキングを生成（scorer.tsのJOCKEY_RANKSと比較）
  console.log('\n=== 動的ランキング（G1スコア順）===')
  const ranked = sorted.sort((a, b) => b.g1Score - a.g1Score).slice(0, 20)
  for (const s of ranked) {
    const score = Math.round(s.g1Score / 10)  // 0-10スケールに変換
    console.log(`  '${s.jockey}': ${score},  // G1: ${s.g1Total}走 ${s.g1PlaceRate}%連対 (全体${s.placeRate}%)`)
  }

  await prisma.$disconnect()
}

main().catch(e => { console.error(e.message); process.exit(1) })
