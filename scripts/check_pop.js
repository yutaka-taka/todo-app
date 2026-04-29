const { PrismaClient } = require('@prisma/client')
const fs = require('fs'), path = require('path')
function loadEnv(f) { try { fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach(l => { const m = l.match(/^([^=#\s][^=]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim() }) } catch {} }
loadEnv('.env'); loadEnv('.env.local')
const prisma = new PrismaClient()
async function main() {
  const entries = await prisma.raceEntry.count()
  const withPop = await prisma.raceEntry.count({ where: { popularity: { not: null } } })
  const withOdds = await prisma.raceEntry.count({ where: { odds: { not: null } } })
  console.log(`RaceEntry: ${entries} 件中、popularity あり ${withPop} 件、odds あり ${withOdds} 件`)
  const results = await prisma.raceResult.count()
  const withPopR = await prisma.raceResult.count({ where: { popularity: { not: null } } })
  const withOddsR = await prisma.raceResult.count({ where: { odds: { not: null } } })
  console.log(`RaceResult: ${results} 件中、popularity あり ${withPopR} 件、odds あり ${withOddsR} 件`)
  const withWeight = await prisma.raceEntry.count({ where: { horseWeight: { not: null } } })
  const withFrame = await prisma.raceEntry.count({ where: { frameNumber: { not: null } } })
  console.log(`Entries: horseWeight あり ${withWeight} 件、frameNumber あり ${withFrame} 件`)

  const sample = await prisma.race.findFirst({ where: { name: { contains: '桜花賞' }, date: { gte: new Date('2024-01-01'), lt: new Date('2025-01-01') } }, include: { entries: true, results: true } })
  if (sample) {
    console.log(`\n${sample.name} ${sample.date.toISOString().slice(0,10)}: entries=${sample.entries.length}`)
    sample.entries.slice(0, 5).forEach(e => console.log(`  ${e.horseNumber}: ${e.horseName}, pop=${e.popularity}, age=${e.age}, jockey=${e.jockey}`))
    console.log(`results sample:`)
    sample.results.slice(0, 3).forEach(r => console.log(`  ${r.finishPosition}: ${r.horseName}, pop=${r.popularity}`))
  }

  const sample2 = await prisma.race.findFirst({ where: { name: { contains: '日本ダービー' }, date: { gte: new Date('2024-01-01'), lt: new Date('2025-01-01') } }, include: { entries: true, results: true } })
  if (sample2) {
    console.log(`\n${sample2.name} ${sample2.date.toISOString().slice(0,10)}:`)
    sample2.results.slice(0, 5).forEach(r => console.log(`  ${r.finishPosition}: ${r.horseName}, pop=${r.popularity}, age=${r.age}`))
  }
}
main().finally(() => prisma.$disconnect())
