'use strict'
/**
 * HorseStat.g2Races/g2Places/g3Races/g3Places バックフィル
 * 既存の RaceResult データから各馬のG2/G3実績を集計して保存する。
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
  console.log('=== HorseStat G2/G3 実績バックフィル ===\n')

  console.log('レース結果を取得中...')
  const allResults = await prisma.raceResult.findMany({
    select: {
      horseName: true,
      finishPosition: true,
      race: { select: { grade: true } },
    },
  })
  console.log(`${allResults.length} 件の結果を取得`)

  // 馬ごとにG2/G3実績を集計
  const horseG2 = new Map()  // horseName -> { races, places }
  const horseG3 = new Map()
  for (const r of allResults) {
    if (!r.horseName?.trim()) continue
    const placed = r.finishPosition <= 2
    if (r.race.grade === 'G2') {
      if (!horseG2.has(r.horseName)) horseG2.set(r.horseName, { races: 0, places: 0 })
      const s = horseG2.get(r.horseName)
      s.races++; if (placed) s.places++
    } else if (r.race.grade === 'G3') {
      if (!horseG3.has(r.horseName)) horseG3.set(r.horseName, { races: 0, places: 0 })
      const s = horseG3.get(r.horseName)
      s.races++; if (placed) s.places++
    }
  }

  const horses = await prisma.horseStat.findMany({ select: { horseName: true } })
  console.log(`HorseStat: ${horses.length} 頭\n`)

  let updated = 0, skipped = 0
  for (const { horseName } of horses) {
    const g2 = horseG2.get(horseName) ?? { races: 0, places: 0 }
    const g3 = horseG3.get(horseName) ?? { races: 0, places: 0 }
    if (g2.races === 0 && g3.races === 0) { skipped++; continue }

    await prisma.horseStat.update({
      where: { horseName },
      data: { g2Races: g2.races, g2Places: g2.places, g3Races: g3.races, g3Places: g3.places },
    })
    updated++
  }

  console.log(`更新: ${updated} 頭（G2/G3実績あり）`)
  console.log(`スキップ: ${skipped} 頭（G2/G3出走なし）`)
  console.log('\n完了')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
