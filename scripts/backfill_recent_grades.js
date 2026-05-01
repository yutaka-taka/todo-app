'use strict'
/**
 * HorseStat.recentGrades バックフィル
 * 既存の RaceResult データから各馬の直近7走グレード列を構築して保存する。
 * recentForm と並列構造: "G1-G2-G3-G1-G2-G3-G1"
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
  console.log('=== HorseStat.recentGrades バックフィル ===\n')

  // 全レース結果をグレード付きで取得（日付昇順）
  console.log('レース結果を取得中...')
  const allResults = await prisma.raceResult.findMany({
    select: {
      horseName: true,
      finishPosition: true,
      race: { select: { grade: true, date: true } },
    },
    orderBy: { race: { date: 'asc' } },
  })
  console.log(`${allResults.length} 件の結果を取得`)

  // 馬ごとに日付降順で最新7走のグレードを収集
  const horseFinishes = new Map()
  for (const r of allResults) {
    if (!r.horseName?.trim()) continue
    if (!horseFinishes.has(r.horseName)) horseFinishes.set(r.horseName, [])
    horseFinishes.get(r.horseName).push({
      date:  r.race.date.getTime(),
      grade: r.race.grade,
    })
  }

  // HorseStat 全件取得
  const horses = await prisma.horseStat.findMany({ select: { horseName: true } })
  console.log(`HorseStat: ${horses.length} 頭\n`)

  let updated = 0, skipped = 0
  for (const { horseName } of horses) {
    const finishes = horseFinishes.get(horseName)
    if (!finishes || finishes.length === 0) { skipped++; continue }

    finishes.sort((a, b) => b.date - a.date)
    const recentGrades = finishes.slice(0, 7).map(f => f.grade).join('-')

    await prisma.horseStat.update({
      where: { horseName },
      data: { recentGrades },
    })
    updated++
  }

  console.log(`更新: ${updated} 頭`)
  console.log(`スキップ（結果なし）: ${skipped} 頭`)
  console.log('\n完了')
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
