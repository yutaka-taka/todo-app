'use strict'
/**
 * KPI 評価フレームワーク（blind 検証）
 *
 * 過去レースで「予想結果 vs 実結果」を比較し Hit@5(1)/Hit@5(2)/ROI を算出。
 *
 * 使い方:
 *   node scripts/eval_full.js
 *   node scripts/eval_full.js --from=2025-01-01 --to=2026-05-13
 *   node scripts/eval_full.js --limit=100
 *   node scripts/eval_full.js --mode=classic  # selectFinalFive を無効化
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

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  })
)

async function main() {
  const fromDate = args.from ? new Date(args.from) : new Date('2025-01-01')
  const toDate   = args.to   ? new Date(args.to)   : new Date()
  const limit    = args.limit ? parseInt(args.limit) : 1000

  console.log(`\n=== KPI 評価 ===`)
  console.log(`期間: ${fromDate.toISOString().split('T')[0]} → ${toDate.toISOString().split('T')[0]}`)

  // 予想と結果の両方がある過去レースを取得
  const races = await prisma.race.findMany({
    where: {
      date: { gte: fromDate, lte: toDate },
      predictions: { some: {} },
      results: { some: { finishPosition: { not: null } } },
    },
    include: {
      predictions: { orderBy: { rank: 'asc' } },
      results: {
        where: { finishPosition: { not: null } },
        orderBy: { finishPosition: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
    take: limit,
  })

  console.log(`対象レース: ${races.length} 件\n`)

  if (races.length === 0) {
    console.log('評価対象レースがありません。自己学習を実行してレース予想を生成してください。')
    await prisma.$disconnect()
    return
  }

  // 統計変数
  let total = 0
  let hit1 = 0   // 5頭中連対馬1頭以上
  let hit2 = 0   // 5頭中連対馬2頭以上
  let roiNumerator = 0    // 馬連払戻推定
  let roiDenominator = 0  // 投資（100円×組合数）

  // グレード別
  const byGrade = {}

  for (const race of races) {
    const top5 = race.predictions.slice(0, 5).map(p => p.horseName)
    const actual = race.results
      .filter(r => r.finishPosition != null && r.finishPosition <= 2)
      .map(r => r.horseName)

    if (actual.length < 2) continue
    total++

    const hits = actual.filter(n => top5.includes(n)).length
    if (hits >= 1) hit1++
    if (hits >= 2) hit2++

    // グレード別
    const g = race.grade
    if (!byGrade[g]) byGrade[g] = { total: 0, hit1: 0, hit2: 0 }
    byGrade[g].total++
    if (hits >= 1) byGrade[g].hit1++
    if (hits >= 2) byGrade[g].hit2++

    // 馬連ROI推定（top5の2頭組合せ×3通りのうち的中組を計上）
    const pairs = []
    for (let i = 0; i < top5.length; i++) {
      for (let j = i + 1; j < top5.length; j++) {
        pairs.push([top5[i], top5[j]])
      }
    }
    for (const [a, b] of pairs) {
      roiDenominator += 100
      if (actual.includes(a) && actual.includes(b)) {
        // 馬連オッズ（平均的な推定値として実際のオッズが欲しいが、ここでは3倍推定）
        const r1 = race.results.find(r => r.horseName === a)
        const r2 = race.results.find(r => r.horseName === b)
        const approxOdds = (r1?.odds ?? 5) * (r2?.odds ?? 5) * 0.75  // 簡易推定
        roiNumerator += Math.min(approxOdds, 300) * 100
      }
    }
  }

  if (total === 0) {
    console.log('有効なレース（連対馬2頭確定済み）がありません。')
    await prisma.$disconnect()
    return
  }

  const roi = roiDenominator > 0 ? roiNumerator / roiDenominator : 0

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`有効レース数   : ${total}`)
  console.log(`Hit@5(1)       : ${(hit1 / total * 100).toFixed(1)}% (目標 92%)   [${hit1}/${total}]`)
  console.log(`Hit@5(2)       : ${(hit2 / total * 100).toFixed(1)}% (目標 35%)   [${hit2}/${total}]`)
  console.log(`馬連ROI(推定)  : ${roi.toFixed(2)} (目標 >0.85)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (Object.keys(byGrade).length > 1) {
    console.log('\nグレード別:')
    for (const [g, v] of Object.entries(byGrade).sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${g.padEnd(4)} total=${v.total} Hit@5(1)=${(v.hit1/v.total*100).toFixed(1)}% Hit@5(2)=${(v.hit2/v.total*100).toFixed(1)}%`)
    }
  }

  // 最近10件の詳細
  console.log('\n直近10件:')
  for (const race of races.slice(0, 10)) {
    const top5 = race.predictions.slice(0, 5).map(p => `${p.horseNumber ?? '?'}${p.horseName}`)
    const actual = race.results.filter(r => r.finishPosition != null && r.finishPosition <= 2).map(r => r.horseName)
    const hits = actual.filter(n => race.predictions.slice(0, 5).map(p => p.horseName).includes(n)).length
    const mark = hits >= 2 ? '◎' : hits >= 1 ? '○' : '×'
    const date = new Date(race.date).toISOString().split('T')[0]
    console.log(`  ${mark} ${date} ${race.name}(${race.grade}) 予想:[${top5.join('/')}] 実績:[${actual.join('/')}]`)
  }

  // JSON ログ出力（.evaluation_log.json に追記）
  const evalRecord = {
    timestamp: new Date().toISOString(),
    period: { from: fromDate.toISOString().split('T')[0], to: toDate.toISOString().split('T')[0] },
    total, hit1, hit2,
    hit1Rate: hit1 / total,
    hit2Rate: hit2 / total,
    roi,
    byGrade: Object.fromEntries(
      Object.entries(byGrade).map(([g, v]) => [g, {
        total: v.total,
        hit1Rate: v.hit1 / v.total,
        hit2Rate: v.hit2 / v.total,
      }])
    ),
  }
  if (args['json-out'] || args['log']) {
    const logPath = path.join(__dirname, '..', '.evaluation_log.json')
    fs.appendFileSync(logPath, JSON.stringify(evalRecord) + '\n', 'utf-8')
    console.log(`\n評価ログ追記: ${logPath}`)
  }
  if (args.json) {
    console.log('\n' + JSON.stringify(evalRecord, null, 2))
  }

  console.log('\n=== 完了 ===\n')
  await prisma.$disconnect()

  return evalRecord
}

main().catch(err => { console.error(err); process.exit(1) })
