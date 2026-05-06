import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { autoLearnFromNewResult } from '@/lib/localAutoLearn'

export const maxDuration = 120

// 全照合済みレースから統計を計算
async function calcAccuracyStats() {
  const racesWithBoth = await prisma.race.findMany({
    where: { predictions: { some: {} }, results: { some: {} } },
    include: {
      predictions: { orderBy: { rank: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'desc' },
  })

  let completeHits = 0
  let halfHits = 0
  let misses = 0

  // 予想順位ごとの的中回数
  const rankHits: Record<number, { attempts: number; hits: number }> = {}
  for (let i = 1; i <= 5; i++) rankHits[i] = { attempts: 0, hits: 0 }

  // 連対率バケット別実際の的中率（キャリブレーション）
  const buckets: Record<string, { predicted: number; actual: number; label: string }> = {
    high:   { predicted: 0, actual: 0, label: '60%以上' },
    mid:    { predicted: 0, actual: 0, label: '40-59%' },
    low:    { predicted: 0, actual: 0, label: '30-39%' },
    verylow:{ predicted: 0, actual: 0, label: '30%未満' },
  }

  const missExamples: string[] = []

  for (const r of racesWithBoth) {
    const top5Names = r.predictions.slice(0, 5).map((p) => p.horseName)
    const actualTop2 = r.results.filter((res) => res.finishPosition <= 2).map((res) => res.horseName)
    if (actualTop2.length < 2) continue

    const hits = actualTop2.filter((a) => top5Names.includes(a)).length
    if (hits === 2) completeHits++
    else if (hits === 1) halfHits++
    else misses++

    // 予想順位ごとの的中トラッキング
    for (const pred of r.predictions.slice(0, 5)) {
      const rk = pred.rank
      if (rankHits[rk]) {
        rankHits[rk].attempts++
        if (actualTop2.includes(pred.horseName)) rankHits[rk].hits++
      }
    }

    // 連対率キャリブレーション
    for (const pred of r.predictions) {
      const rate = pred.placeRate
      const connected = actualTop2.includes(pred.horseName) ? 1 : 0
      if (rate >= 60)      { buckets.high.predicted++; buckets.high.actual += connected }
      else if (rate >= 40) { buckets.mid.predicted++;  buckets.mid.actual  += connected }
      else if (rate >= 30) { buckets.low.predicted++;  buckets.low.actual  += connected }
      else                 { buckets.verylow.predicted++; buckets.verylow.actual += connected }
    }

    // 外れ事例の収集
    if (hits < 2) {
      const surprises = actualTop2.filter((a) => !top5Names.includes(a))
      const topPred = r.predictions.slice(0, 3).map(
        (p) => `${p.rank}位${p.horseName}(${p.placeRate}%)`
      ).join('/')
      missExamples.push(`${r.name}: 予想[${topPred}] → 実際[${actualTop2.join('/')}] 予想外:[${surprises.join('/')}]`)
    }
  }

  const total = racesWithBoth.length
  const accuracy = total > 0
    ? Math.round((completeHits * 2 + halfHits) / (total * 2) * 1000) / 10
    : 0

  return {
    total,
    accuracy,
    completeHits,
    halfHits,
    misses,
    rankHits,
    buckets,
    missExamples: missExamples.slice(0, 10),
  }
}

// GET: 予想済みかつ結果未入力のレース一覧 + 精度統計
export async function GET() {
  try {
    const today = new Date()

    const [races, stats] = await Promise.all([
      prisma.race.findMany({
        where: {
          date: { lt: today },
          predictions: { some: {} },
          results: { none: {} },
        },
        include: {
          predictions: { orderBy: { rank: 'asc' }, take: 5 },
        },
        orderBy: { date: 'desc' },
        take: 10,
      }),
      calcAccuracyStats(),
    ])

    return NextResponse.json({
      races: races.map((r) => ({
        id: r.id,
        name: r.name,
        date: r.date.toISOString(),
        predictions: r.predictions.map((p) => ({
          rank: p.rank,
          horseName: p.horseName,
          horseNumber: p.horseNumber,
          placeRate: p.placeRate,
        })),
      })),
      stats,
    })
  } catch (error) {
    console.error('Results GET error:', error)
    return NextResponse.json({ error: '取得失敗' }, { status: 500 })
  }
}

// POST: 実際の1着・2着を入力 → ローカル自動学習（Claude不要）
export async function POST(request: NextRequest) {
  try {
    const { raceId, first, second } = await request.json()

    if (!raceId || !first?.trim() || !second?.trim()) {
      return NextResponse.json({ error: 'raceId・1着・2着の馬名が必要です' }, { status: 400 })
    }
    if (first.trim() === second.trim()) {
      return NextResponse.json({ error: '1着と2着は異なる馬名を入力してください' }, { status: 400 })
    }

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: {
        predictions: { orderBy: { rank: 'asc' } },
        results: true,
        entries: true,
      },
    })

    if (!race) return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })
    if (race.results.length > 0) {
      return NextResponse.json({ error: '既に結果が入力済みです' }, { status: 400 })
    }

    const firstName = first.trim()
    const secondName = second.trim()

    const entry1 = race.entries.find((e) => e.horseName === firstName)
    const entry2 = race.entries.find((e) => e.horseName === secondName)

    await prisma.raceResult.createMany({
      data: [
        { raceId, finishPosition: 1, horseNumber: entry1?.horseNumber ?? 97, horseName: firstName },
        { raceId, finishPosition: 2, horseNumber: entry2?.horseNumber ?? 98, horseName: secondName },
      ],
    })

    // 今回レースの照合
    const predictedTop5 = race.predictions.slice(0, 5).map((p) => p.horseName)
    const firstHit  = predictedTop5.includes(firstName)
    const secondHit = predictedTop5.includes(secondName)
    const hitCount  = (firstHit ? 1 : 0) + (secondHit ? 1 : 0)
    const thisAccuracy = hitCount * 50

    const missInfo = [
      firstHit  ? `1着「${firstName}」✓ 予想内`  : `1着「${firstName}」✗ 予想外`,
      secondHit ? `2着「${secondName}」✓ 予想内` : `2着「${secondName}」✗ 予想外`,
    ].join(' / ')

    // ローカル自動学習: HorseStat更新 + 因子重み調整（Claude不要）
    const learnResult = await autoLearnFromNewResult({
      raceId,
      winnerName: firstName,
      secondName,
      raceName:       race.name,
      grade:          race.grade,
      venue:          race.venue,
      surface:        race.surface,
      distance:       race.distance,
      raceDate:       race.date,
      trackCondition: race.trackCondition ?? null,
      participants:   race.entries.map((e) => ({ name: e.horseName, popularity: e.popularity ?? null })),
    })

    // 統計再計算
    const stats = await calcAccuracyStats()

    const patternAnalysis = missInfo +
      ` | 自動学習: 馬データ${learnResult.horsesUpdated}頭更新` +
      (learnResult.weightsUpdated ? '・因子重み最適化' : '') +
      ` (v${learnResult.newVersion} 通算精度${learnResult.localAccuracy}%)`

    await prisma.race.update({ where: { id: raceId }, data: { analyzed: true } })

    return NextResponse.json({
      hitCount,
      accuracy: thisAccuracy,
      missInfo,
      patternAnalysis,
      algorithmChange: `ローカル自動学習: 1着${firstName}・2着${secondName}のHorseStatを更新。アルゴリズムv${learnResult.newVersion}に自動改善。`,
      algorithmUpdated: true,
      localLearn: learnResult,
      overallStats: {
        total:         stats.total,
        accuracy:      stats.accuracy,
        completeHits:  stats.completeHits,
        halfHits:      stats.halfHits,
        misses:        stats.misses,
      },
    })
  } catch (error) {
    console.error('Results POST error:', error)
    const message = error instanceof Error ? error.message : '結果の保存に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
