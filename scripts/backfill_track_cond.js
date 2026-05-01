'use strict'
/**
 * HorseStat.trackCondData バックフィル
 * 既存の RaceResult データから馬場状態別連対実績を集計して保存する。
 * 対象: 良/稍重/重/不良 の全条件（trackCondition が null のレースは除外）
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
  console.log('=== HorseStat.trackCondData バックフィル ===\n')

  console.log('馬場状態付きレース結果を取得中...')
  const allResults = await prisma.raceResult.findMany({
    select: {
      horseName: true,
      finishPosition: true,
      race: { select: { trackCondition: true } },
    },
  })
  console.log(`${allResults.length} 件の結果を取得`)

  // 馬ごとに馬場状態別実績を集計
  // horseTrackCond: horseName -> { "良": {races, places}, "稍重": {...}, ... }
  const horseTrackCond = new Map()
  let skippedNoTC = 0
  for (const r of allResults) {
    if (!r.horseName?.trim()) continue
    const tc = r.race.trackCondition
    if (!tc) { skippedNoTC++; continue }
    const placed = r.finishPosition <= 2
    if (!horseTrackCond.has(r.horseName)) horseTrackCond.set(r.horseName, {})
    const data = horseTrackCond.get(r.horseName)
    if (!data[tc]) data[tc] = { races: 0, places: 0 }
    data[tc].races++
    if (placed) data[tc].places++
  }
  console.log(`馬場条件なし（スキップ）: ${skippedNoTC} 件`)

  const horses = await prisma.horseStat.findMany({ select: { horseName: true } })
  console.log(`HorseStat: ${horses.length} 頭\n`)

  let updated = 0, skipped = 0
  for (const { horseName } of horses) {
    const trackCondData = horseTrackCond.get(horseName)
    if (!trackCondData || Object.keys(trackCondData).length === 0) { skipped++; continue }

    await prisma.horseStat.update({
      where: { horseName },
      data: { trackCondData },
    })
    updated++
  }

  console.log(`更新: ${updated} 頭`)
  console.log(`スキップ: ${skipped} 頭（馬場状態付きレース結果なし）`)

  // 集計サマリ表示
  console.log('\n馬場状態別カバレッジ:')
  const condCounts = {}
  for (const data of horseTrackCond.values()) {
    for (const [tc, v] of Object.entries(data)) {
      if (!condCounts[tc]) condCounts[tc] = { horses: 0, totalRaces: 0, totalPlaces: 0 }
      condCounts[tc].horses++
      condCounts[tc].totalRaces += v.races
      condCounts[tc].totalPlaces += v.places
    }
  }
  for (const [tc, v] of Object.entries(condCounts)) {
    const rate = v.totalRaces > 0 ? Math.round(v.totalPlaces / v.totalRaces * 100) : 0
    console.log(`  ${tc}: ${v.horses}頭, ${v.totalRaces}走, ${v.totalPlaces}連対 (${rate}%)`)
  }

  console.log('\n完了')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
