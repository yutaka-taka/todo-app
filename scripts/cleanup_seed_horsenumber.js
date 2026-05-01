'use strict'
/**
 * 旧 seed RaceResult のクリーンアップ
 *
 * 問題:
 *   旧 seed が finishPosition をそのまま horseNumber に流用しているレコードが多数。
 *   1905 行中 288 行で horseNumber == finishPosition、上位 5 位のみ「馬番=1〜5 / 着順=1〜5」
 *   のレースが G2/G3 等で散見される。
 *
 * 戦略:
 *   horseNumber == finishPosition の RaceResult のみ削除。
 *   その後 backfill_raceresult_from_horses.js で正しい馬番に復元する。
 *
 * Args:
 *   --dry-run             削除予定数の出力のみ
 *   --force               実削除実行
 *   --cutoff=YYYY-MM-DD   この日付より古い createdAt の行のみ対象（既定 2026-04-30）
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
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force  = args.includes('--force')
  const cutoffArg = args.find(x => x.startsWith('--cutoff='))
  const cutoff = new Date(cutoffArg ? cutoffArg.split('=')[1] : '2026-04-30')

  if (!dryRun && !force) {
    console.error('--dry-run か --force のいずれかを指定してください'); process.exit(1)
  }
  console.log(`cutoff: createdAt < ${cutoff.toISOString().slice(0,10)}`)

  // horseNumber == finishPosition かつ createdAt < cutoff の行を抽出
  const all = await prisma.raceResult.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, raceId: true, horseNumber: true, finishPosition: true, horseName: true, createdAt: true },
  })
  const targets = all.filter(r => r.horseNumber === r.finishPosition)

  // HorseStat に存在する馬名のセット
  const horses = await prisma.horseStat.findMany({ select: { horseName: true } })
  const horseSet = new Set(horses.map(h => h.horseName))

  const inHorseStat   = targets.filter(r => horseSet.has(r.horseName))
  const noHorseStat   = targets.filter(r => !horseSet.has(r.horseName))

  console.log(`削除対象: ${targets.length} 件`)
  console.log(`  └ HorseStat にいる馬（profile から復元可能）: ${inHorseStat.length} 件`)
  console.log(`  └ HorseStat にない馬（復元不能・データ消失）: ${noHorseStat.length} 件`)

  // レース別の削除予定
  const byRace = {}
  for (const r of targets) {
    byRace[r.raceId] = (byRace[r.raceId] || 0) + 1
  }
  console.log(`影響レース数: ${Object.keys(byRace).length}`)

  // サンプル: HorseStat にない馬の名前 上位10件
  if (noHorseStat.length) {
    const counts = {}
    for (const r of noHorseStat) counts[r.horseName] = (counts[r.horseName] || 0) + 1
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0, 10)
    console.log('\n復元不能な馬（上位10）:')
    top.forEach(([n, c]) => console.log(`  ${n}: ${c} 行`))
  }

  if (dryRun) {
    console.log('\n=== dry-run のため削除は実行されませんでした ===')
    await prisma.$disconnect(); return
  }

  // 実削除
  const ids = targets.map(r => r.id)
  console.log(`\n${ids.length} 行を削除します...`)
  // 大量だと BIND 上限を超える可能性 → 分割
  let deleted = 0
  const BATCH = 500
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const r = await prisma.raceResult.deleteMany({ where: { id: { in: chunk } } })
    deleted += r.count
  }
  console.log(`削除完了: ${deleted} 行`)

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
