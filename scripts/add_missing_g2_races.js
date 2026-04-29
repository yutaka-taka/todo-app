'use strict'
/**
 * 不足しているG2レースを直接DBに追加
 * 今週末（5/2-5/3）の京王杯スプリングカップを含む
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

const races = [
  { name: '京王杯スプリングカップ2026', date: '2026-05-02', venue: '東京', grade: 'G2', surface: '芝', distance: 1400 },
]

async function main() {
  for (const r of races) {
    const existing = await prisma.race.findFirst({ where: { name: r.name } })
    if (existing) {
      const updated = await prisma.race.update({
        where: { id: existing.id },
        data: { date: new Date(r.date), venue: r.venue, grade: r.grade, surface: r.surface, distance: r.distance },
      })
      console.log(`UPDATED: ${updated.name} ${updated.date.toISOString().slice(0,10)} ${updated.grade} ${updated.venue}`)
    } else {
      const created = await prisma.race.create({
        data: { ...r, date: new Date(r.date) },
      })
      console.log(`CREATED: ${created.name} ${created.date.toISOString().slice(0,10)} ${created.grade} ${created.venue}`)
    }
  }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
