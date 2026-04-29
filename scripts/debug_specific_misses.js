'use strict'
/**
 * 特定の外れレースのスコア詳細を出力して問題点を特定
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

async function main() {
  // 桜花賞2024 のステレンボッシュを調査
  const cases = [
    { name: '桜花賞', year: 2024, target: ['ステレンボッシュ', 'ライトバック', 'アスコリピチェーノ'] },
    { name: '日本ダービー', year: 2024, target: ['ダノンデサイル', 'サンライズアース', 'ジャンタルマンタル', 'ジャスティンミラノ'] },
    { name: 'ヴィクトリアマイル', year: 2024, target: ['テンハッピーローズ', 'マスクトディーヴァ', 'ソングライン'] },
  ]

  for (const cs of cases) {
    const races = await prisma.race.findMany({
      where: { name: { contains: cs.name }, date: { gte: new Date(`${cs.year}-01-01`), lt: new Date(`${cs.year+1}-01-01`) } },
      include: { entries: true, results: true },
    })
    if (races.length === 0) { console.log(`${cs.name}${cs.year} 見つからず`); continue }
    const race = races[0]
    console.log(`\n=== ${race.name} (${race.date.toISOString().slice(0,10)}) ===`)
    console.log(`Grade: ${race.grade}, Distance: ${race.distance}m ${race.surface}, Venue: ${race.venue}`)

    // この時点までの統計を作る
    const priorRaces = await prisma.race.findMany({
      where: { date: { lt: race.date } },
      include: { results: true },
      orderBy: { date: 'asc' },
    })
    console.log(`(過去${priorRaces.length}レースで統計構築)`)

    const statsMap = new Map()
    const finishesMap = new Map()
    for (const pr of priorRaces) {
      for (const result of pr.results) {
        if (!result.horseName?.trim()) continue
        const placed = result.finishPosition <= 2
        if (!statsMap.has(result.horseName)) {
          statsMap.set(result.horseName, {
            totalRaces: 0, totalPlaces: 0, g1Races: 0, g1Places: 0,
            distanceData: {}, venueData: {}, surfaceData: {}, raceNameData: {},
            recentForm: null, lastRaceDate: null, lastRacePopularity: null,
          })
        }
        const s = statsMap.get(result.horseName)
        s.totalRaces++; if (placed) s.totalPlaces++
        if (pr.grade === 'G1') { s.g1Races++; if (placed) s.g1Places++ }
        const dk = String(pr.distance)
        if (!s.distanceData[dk]) s.distanceData[dk] = { races: 0, places: 0 }
        s.distanceData[dk].races++; if (placed) s.distanceData[dk].places++
        if (!s.venueData[pr.venue]) s.venueData[pr.venue] = { races: 0, places: 0 }
        s.venueData[pr.venue].races++; if (placed) s.venueData[pr.venue].places++
        if (!finishesMap.has(result.horseName)) finishesMap.set(result.horseName, [])
        finishesMap.get(result.horseName).push({ date: pr.date.getTime(), position: result.finishPosition })
        const finishes = finishesMap.get(result.horseName)
        finishes.sort((a, b) => b.date - a.date)
        s.recentForm = finishes.slice(0, 7).map(f => f.position).join('-')
        s.lastRaceDate = pr.date
        if (result.popularity != null) s.lastRacePopularity = result.popularity
      }
    }

    for (const t of cs.target) {
      const stat = statsMap.get(t)
      const entry = race.entries.find(e => e.horseName === t)
      const result = race.results.find(r => r.horseName === t)
      if (!entry && !result) { console.log(`  ${t}: 出走情報なし`); continue }
      const e = entry || result
      console.log(`\n  ${t}:`)
      console.log(`    人気: ${e?.popularity ?? '?'}, 年齢: ${e?.age ?? '?'}, 着順: ${result?.finishPosition ?? '-'}`)
      if (!stat) {
        console.log(`    過去成績: なし（新馬・初出走）`)
      } else {
        console.log(`    過去成績: ${stat.totalRaces}戦${stat.totalPlaces}連対 (連対率${(stat.totalPlaces/stat.totalRaces*100).toFixed(0)}%)`)
        console.log(`    G1成績: ${stat.g1Races}戦${stat.g1Places}連対`)
        console.log(`    直近フォーム: ${stat.recentForm || 'なし'}`)
        const distKey = String(race.distance)
        const dD = stat.distanceData[distKey]
        if (dD) console.log(`    ${race.distance}m: ${dD.races}戦${dD.places}連対`)
      }
    }
  }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
