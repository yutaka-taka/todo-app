'use strict'
/**
 * 種牡馬(父)・母父の産駒適性テーブルを ml/pedigree_aptitude.json に出力する。
 *   node scripts/build_pedigree_aptitude.js
 *
 * 各 sire / bms について、産駒の「距離帯別・馬場別 連対率」を集計。
 * serving(mlFeatures.ts)はこのテーブルを参照し、対象レースの距離帯/馬場から
 * sire_dist_rate / sire_surf_rate / bms_dist_rate を引く（当日不要・数日前でも計算可）。
 * 血統は fetch_pedigree.js が HorseStat に蓄積したものを使う。未取得馬は集計対象外。
 *
 * 注意: serving の「全データ集計」は、予想対象が未来レースである限り
 *      「対象レース日より前の全データ」と一致するため point-in-time と整合する。
 *      訓練側(build_dataset.py)は as-of-date で別途算出（リーク防止）。
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

const OUT = path.join(__dirname, '..', 'ml', 'pedigree_aptitude.json')
const MIN_SAMPLE = 10  // この出走数未満は信頼できないので出力しない（serving 側で既定値へ）
const SEP = ''

function distanceBin(d) {
  if (d <= 1400) return 0
  if (d <= 1700) return 1
  if (d <= 2100) return 2
  return 3
}

function inc(map, a, b) {
  const k = a + SEP + b
  const e = map.get(k) || [0, 0]
  e[0]++
  map.set(k, e)
  return e
}

function toRates(map) {
  const out = {}
  for (const [k, rp] of map) {
    if (rp[0] < MIN_SAMPLE) continue
    const idx = k.indexOf(SEP)
    const a = k.slice(0, idx)
    const b = k.slice(idx + 1)
    if (!out[a]) out[a] = {}
    out[a][b] = +(rp[1] / rp[0]).toFixed(4)
  }
  return out
}

async function main() {
  console.log('=== 血統適性テーブル構築 ===')
  const peds = await prisma.horseStat.findMany({
    where: { sire: { not: null } },
    select: { horseName: true, sire: true, sireOfDam: true },
  })
  const pedMap = new Map(peds.map(p => [p.horseName, p]))
  console.log(`血統保有馬: ${pedMap.size} 頭`)
  if (pedMap.size === 0) {
    console.log('血統データ未取得。fetch_pedigree.js 実行後に再度。空テーブルを出力。')
    fs.writeFileSync(OUT, JSON.stringify({ sireDist: {}, sireSurf: {}, bmsDist: {}, builtAt: new Date().toISOString(), horses: 0 }))
    await prisma.$disconnect(); return
  }

  const sireDist = new Map(), sireSurf = new Map(), bmsDist = new Map()
  const CHUNK = 5000
  let skip = 0, rows = 0
  while (true) {
    const chunk = await prisma.race.findMany({
      take: CHUNK, skip, orderBy: { id: 'asc' },
      select: { surface: true, distance: true, results: { where: { finishPosition: { not: null } }, select: { horseName: true, finishPosition: true } } },
    })
    if (chunk.length === 0) break
    skip += chunk.length
    for (const r of chunk) {
      const bin = distanceBin(r.distance)
      for (const res of r.results) {
        const ped = pedMap.get((res.horseName || '').trim())
        if (!ped) continue
        const placed = res.finishPosition <= 2 ? 1 : 0
        rows++
        if (ped.sire) {
          inc(sireDist, ped.sire, bin)[1] += placed
          inc(sireSurf, ped.sire, r.surface)[1] += placed
        }
        if (ped.sireOfDam) inc(bmsDist, ped.sireOfDam, bin)[1] += placed
      }
    }
  }

  const table = {
    sireDist: toRates(sireDist), sireSurf: toRates(sireSurf), bmsDist: toRates(bmsDist),
    builtAt: new Date().toISOString(), horses: pedMap.size, sampleRows: rows,
  }
  fs.writeFileSync(OUT, JSON.stringify(table))
  console.log(`出力: ${path.relative(process.cwd(), OUT)}  sire=${Object.keys(table.sireDist).length} bms=${Object.keys(table.bmsDist).length} (${rows} 産駒走)`)
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
