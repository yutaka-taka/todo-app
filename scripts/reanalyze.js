'use strict'
/**
 * HorseStat 再構築スクリプト（/api/reanalyze と同等の処理）
 * Next.js サーバー不要。直接 Prisma で DB を更新する。
 *
 * 使い方:
 *   node scripts/reanalyze.js
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

function getIntervalBin(days) {
  if (days <= 13)  return 'rensen'
  if (days <= 20)  return 'standard2'
  if (days <= 27)  return 'standard3'
  if (days <= 34)  return 'standard4'
  if (days <= 41)  return 'standard5'
  if (days <= 62)  return 'medium'
  if (days <= 119) return 'shortRest'
  if (days <= 180) return 'midRest'
  return 'longRest'
}

function normalizeRaceName(name) {
  return name.replace(/\s*\d{4}年?\s*$/, '').trim()
}

function buildHorseStatsFromResults(races) {
  const statsMap = new Map()
  const finishesMap = new Map()
  const weightsMap = new Map()

  for (const race of races) {
    if (race.results.length === 0) continue
    const raceKey = normalizeRaceName(race.name)
    for (const result of race.results) {
      if (!result.horseName?.trim()) continue
      if (result.finishPosition == null) continue
      const placed = result.finishPosition <= 2

      if (!statsMap.has(result.horseName)) {
        statsMap.set(result.horseName, {
          horseName: result.horseName,
          totalRaces: 0, totalPlaces: 0,
          g1Races: 0, g1Places: 0,
          g2Races: 0, g2Places: 0,
          g3Races: 0, g3Places: 0,
          distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
          trackCondData: {}, intervalData: {}, courseDistData: {},
          lastRaceDate: race.date,
        })
      }
      const stat = statsMap.get(result.horseName)
      stat.totalRaces++
      if (placed) stat.totalPlaces++
      if (race.grade === 'G1') { stat.g1Races++; if (placed) stat.g1Places++ }
      else if (race.grade === 'G2') { stat.g2Races++; if (placed) stat.g2Places++ }
      else if (race.grade === 'G3') { stat.g3Races++; if (placed) stat.g3Places++ }

      const dk = String(race.distance)
      if (!stat.distanceData[dk]) stat.distanceData[dk] = { races: 0, places: 0 }
      stat.distanceData[dk].races++; if (placed) stat.distanceData[dk].places++

      if (!stat.venueData[race.venue]) stat.venueData[race.venue] = { races: 0, places: 0 }
      stat.venueData[race.venue].races++; if (placed) stat.venueData[race.venue].places++

      if (!stat.surfaceData[race.surface]) stat.surfaceData[race.surface] = { races: 0, places: 0 }
      stat.surfaceData[race.surface].races++; if (placed) stat.surfaceData[race.surface].places++

      if (!stat.raceNameData[raceKey]) stat.raceNameData[raceKey] = { races: 0, places: 0 }
      stat.raceNameData[raceKey].races++; if (placed) stat.raceNameData[raceKey].places++

      const cdKey = `${race.venue}-${race.surface}-${race.distance}`
      if (!stat.courseDistData[cdKey]) stat.courseDistData[cdKey] = { races: 0, places: 0 }
      stat.courseDistData[cdKey].races++; if (placed) stat.courseDistData[cdKey].places++

      if (race.trackCondition) {
        const tc = race.trackCondition
        if (!stat.trackCondData[tc]) stat.trackCondData[tc] = { races: 0, places: 0 }
        stat.trackCondData[tc].races++; if (placed) stat.trackCondData[tc].places++
      }

      if (race.date > stat.lastRaceDate) stat.lastRaceDate = race.date

      if (!finishesMap.has(result.horseName)) finishesMap.set(result.horseName, [])
      finishesMap.get(result.horseName).push({
        date: race.date, position: result.finishPosition ?? 99,
        popularity: result.popularity ?? null, grade: race.grade,
      })

      if (result.horseWeight != null && result.horseWeight > 0) {
        if (!weightsMap.has(result.horseName)) weightsMap.set(result.horseName, [])
        weightsMap.get(result.horseName).push(result.horseWeight)
      }
    }
  }

  finishesMap.forEach((finishes, horseName) => {
    const stat = statsMap.get(horseName)
    if (!stat || finishes.length === 0) return
    finishes.sort((a, b) => b.date.getTime() - a.date.getTime())
    const recent = finishes.slice(0, 5)
    stat.recentForm   = recent.map(f => f.position).join('-')
    stat.recentGrades = recent.map(f => f.grade).join('-')
    stat.recentPops   = recent.map(f => f.popularity ?? 0).join('-')
    stat.lastRacePopularity = finishes[0].popularity ?? null

    const asc = finishes.slice().sort((a, b) => a.date.getTime() - b.date.getTime())
    for (let i = 1; i < asc.length; i++) {
      const days = Math.floor((asc[i].date.getTime() - asc[i - 1].date.getTime()) / 86400000)
      if (days <= 0) continue
      const bin = getIntervalBin(days)
      if (!stat.intervalData[bin]) stat.intervalData[bin] = { races: 0, places: 0 }
      stat.intervalData[bin].races++
      if (asc[i].position <= 2) stat.intervalData[bin].places++
    }
  })

  weightsMap.forEach((weights, horseName) => {
    const stat = statsMap.get(horseName)
    if (!stat || weights.length === 0) return
    stat.avgHorseWeight = weights.reduce((a, b) => a + b, 0) / weights.length
    stat.weightSamples  = weights.length
  })

  return Array.from(statsMap.values())
}

async function main() {
  console.log('\n=== HorseStat 再構築 ===')
  const startAt = Date.now()

  const CHUNK = 5000
  const allStatsMap = new Map()
  let skipCount = 0
  let totalRaces = 0

  while (true) {
    const chunk = await prisma.race.findMany({
      take: CHUNK, skip: skipCount, orderBy: { id: 'asc' },
      include: {
        results: {
          where: { finishPosition: { not: null } },
          orderBy: { finishPosition: 'asc' },
        },
      },
    })
    if (chunk.length === 0) break
    skipCount += chunk.length
    totalRaces += chunk.length
    process.stdout.write(`  チャンク処理中... ${totalRaces} レース\r`)

    const chunkStats = buildHorseStatsFromResults(
      chunk.map(r => ({
        name: r.name, grade: r.grade, venue: r.venue,
        surface: r.surface, distance: r.distance, date: r.date,
        trackCondition: r.trackCondition ?? null,
        results: r.results.map(res => ({
          horseName: res.horseName,
          finishPosition: res.finishPosition ?? 99,
          popularity: res.popularity ?? null,
          horseWeight: res.horseWeight ?? null,
        })),
      }))
    )

    for (const s of chunkStats) {
      const ex = allStatsMap.get(s.horseName)
      if (!ex) {
        allStatsMap.set(s.horseName, s)
      } else {
        ex.totalRaces  += s.totalRaces;  ex.totalPlaces += s.totalPlaces
        ex.g1Races  += s.g1Races;  ex.g1Places  += s.g1Places
        ex.g2Races  += s.g2Races;  ex.g2Places  += s.g2Places
        ex.g3Races  += s.g3Races;  ex.g3Places  += s.g3Places
        for (const [k, v] of Object.entries(s.distanceData))  ex.distanceData[k]  = ex.distanceData[k]  ? { races: ex.distanceData[k].races  + v.races, places: ex.distanceData[k].places  + v.places } : v
        for (const [k, v] of Object.entries(s.venueData))     ex.venueData[k]     = ex.venueData[k]     ? { races: ex.venueData[k].races     + v.races, places: ex.venueData[k].places     + v.places } : v
        for (const [k, v] of Object.entries(s.surfaceData))   ex.surfaceData[k]   = ex.surfaceData[k]   ? { races: ex.surfaceData[k].races   + v.races, places: ex.surfaceData[k].places   + v.places } : v
        for (const [k, v] of Object.entries(s.raceNameData))  ex.raceNameData[k]  = ex.raceNameData[k]  ? { races: ex.raceNameData[k].races  + v.races, places: ex.raceNameData[k].places  + v.places } : v
        for (const [k, v] of Object.entries(s.trackCondData)) ex.trackCondData[k] = ex.trackCondData[k] ? { races: ex.trackCondData[k].races + v.races, places: ex.trackCondData[k].places + v.places } : v
        for (const [k, v] of Object.entries(s.intervalData))  ex.intervalData[k]  = ex.intervalData[k]  ? { races: ex.intervalData[k].races  + v.races, places: ex.intervalData[k].places  + v.places } : v
        for (const [k, v] of Object.entries(s.courseDistData)) ex.courseDistData[k] = ex.courseDistData[k] ? { races: ex.courseDistData[k].races + v.races, places: ex.courseDistData[k].places + v.places } : v
        if (s.lastRaceDate > ex.lastRaceDate) {
          ex.lastRaceDate = s.lastRaceDate
          ex.lastRacePopularity = s.lastRacePopularity
          ex.recentForm   = s.recentForm
          ex.recentGrades = s.recentGrades
          ex.recentPops   = s.recentPops
        }
        if (s.avgHorseWeight != null) {
          const ws = (ex.weightSamples ?? 0) + (s.weightSamples ?? 0)
          if (ws > 0) {
            ex.avgHorseWeight = ((ex.avgHorseWeight ?? s.avgHorseWeight ?? 0) * (ex.weightSamples ?? 0) + s.avgHorseWeight * (s.weightSamples ?? 0)) / ws
            ex.weightSamples = ws
          }
        }
      }
    }
  }

  const freshStats = Array.from(allStatsMap.values())
  console.log(`\n  集計完了: ${totalRaces} レース → ${freshStats.length} 頭`)

  // 全件削除 → 再作成
  console.log('  HorseStat 全件削除中...')
  await prisma.horseStat.deleteMany({})

  console.log(`  HorseStat 書き込み中... (${freshStats.length} 頭)`)
  let saved = 0
  const WRITE_CHUNK = 200
  for (let i = 0; i < freshStats.length; i += WRITE_CHUNK) {
    const batch = freshStats.slice(i, i + WRITE_CHUNK)
    for (const hs of batch) {
      try {
        await prisma.horseStat.create({
          data: {
            horseName: hs.horseName,
            totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
            g1Races: hs.g1Races, g1Places: hs.g1Places,
            g2Races: hs.g2Races, g2Places: hs.g2Places,
            g3Races: hs.g3Races, g3Places: hs.g3Places,
            distanceData: hs.distanceData, venueData: hs.venueData,
            surfaceData: hs.surfaceData, raceNameData: hs.raceNameData,
            intervalData: hs.intervalData, courseDistData: hs.courseDistData,
            avgHorseWeight: hs.avgHorseWeight ?? null,
            weightSamples:  hs.weightSamples ?? 0,
            lastRaceDate:   hs.lastRaceDate,
            lastRacePopularity: hs.lastRacePopularity ?? null,
            recentForm:   hs.recentForm ?? null,
            recentGrades: hs.recentGrades ?? null,
            recentPops:   hs.recentPops ?? null,
          },
        })
        saved++
      } catch (e) {
        // skip duplicate
      }
    }
    process.stdout.write(`  書き込み: ${saved} / ${freshStats.length}\r`)
  }

  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1)
  console.log(`\n\n=== 完了 ===`)
  console.log(`  保存: ${saved} 頭 / ${totalRaces} レース (${elapsed}秒)`)
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
