import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { generatePrediction } from '@/lib/ai'
import { localScoreHorses } from '@/lib/scorer'
import { getLocalWeights } from '@/lib/localAutoLearn'
import { findNetkeibaRaceId, fetchOddsRanking } from '@/lib/netkeibaRaceId'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'

export const maxDuration = 300

// ローカル予想に切り替えるHorseStat件数の閾値
const LOCAL_MODE_THRESHOLD = 500

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { raceId } = body
    const horseWeights: Record<string, { weight: number | null; weightChange: number | null }> | undefined = body.horseWeights
    const trackCondition: string | undefined = body.trackCondition
    const trainingData: Record<string, {
      lastThreeFurlong?: number | null
      runningStyle?: string | null
    }> | undefined = body.trainingData
    if (!raceId) return NextResponse.json({ error: 'raceIdが必要です' }, { status: 400 })

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      include: { entries: { orderBy: { horseNumber: 'asc' } } },
    })
    if (!race) return NextResponse.json({ error: 'レースが見つかりません' }, { status: 404 })

    const algorithmConfig = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })

    const horseStatCount = await prisma.horseStat.count()
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY
    const hasEntries = race.entries.length > 0

    // ユーザー入力（体重・調教・上がり3F・脚質）をエントリにマージ
    const weightedEntries = race.entries.map((e) => {
      const wData = horseWeights?.[e.horseName]
      const tData = trainingData?.[e.horseName]
      return {
        ...e,
        horseWeight: wData?.weight ?? e.horseWeight ?? null,
        weightChange: wData?.weightChange ?? null,
        lastThreeFurlong: tData?.lastThreeFurlong ?? null,
        runningStyle: tData?.runningStyle ?? null,
      }
    })
    const isLocalModeReady = horseStatCount >= LOCAL_MODE_THRESHOLD

    // オッズ取得（データ不足馬補正用・失敗しても予想は続行）
    let oddsRanking: Record<number, number> = {}
    try {
      const netkeibaRaceId = await findNetkeibaRaceId(race.venue, new Date(race.date))
      if (netkeibaRaceId) {
        oddsRanking = await fetchOddsRanking(netkeibaRaceId)
      }
    } catch { /* オッズ取得失敗は無視 */ }

    // オッズ情報をエントリにマージ（馬番で紐付け）
    // ライブnetkeibaオッズ → DBに保存されている popularity の順でフォールバック
    const entriesWithOdds = weightedEntries.map((e) => ({
      ...e,
      oddsPopularity: oddsRanking[e.horseNumber] ?? e.popularity ?? null,
    }))

    let predictions
    let analysis = ''
    let mode: 'local' | 'ai' = 'ai'

    // ローカル予想: 馬データが十分 AND 出走馬が確定している場合
    if (isLocalModeReady && hasEntries) {
      mode = 'local'
      const horseNames = entriesWithOdds.map((e) => e.horseName)
      const [stats, weights] = await Promise.all([
        prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } }),
        getLocalWeights(),
      ])
      const raceWithCond = { ...race, trackCondition: trackCondition ?? race.trackCondition ?? undefined, date: race.date }
      const scored = localScoreHorses(entriesWithOdds, raceWithCond, stats, weights)
      predictions = scored
      const coveredCount = stats.length
      analysis = `【ローカル予想モード】蓄積済み馬データ${horseStatCount}頭を使用（Claude API不要）。出走${race.entries.length}頭中${coveredCount}頭のデータがDBに存在します。残り${race.entries.length - coveredCount}頭は平均値で推定。レース結果を入力するたびに自動学習し精度が向上します。`
    } else if (hasApiKey) {
      // AI予想モード
      try {
        mode = 'ai'
        const rules = algorithmConfig?.rules ?? '基本的な連対率予測を行います。'
        const raceDate = format(new Date(race.date), 'yyyy年M月d日(E)', { locale: ja })
        const result = await generatePrediction({
          raceName: race.name,
          raceDate,
          venue: race.venue,
          surface: race.surface,
          distance: race.distance,
          grade: race.grade,
          entries: weightedEntries.map((e) => ({
            horseNumber: e.horseNumber,
            horseName: e.horseName,
            jockey: e.jockey,
            age: e.age,
            sex: e.sex,
            weight: e.weight,
            horseWeight: e.horseWeight,
            weightChange: e.weightChange,
          })),
          algorithmRules: rules,
        })
        predictions = result.predictions
        analysis = result.analysis
      } catch (aiError) {
        // AI失敗時はローカルにフォールバック
        console.warn('AI prediction failed, falling back to local:', aiError)
        mode = 'local'
        const stats = hasEntries
          ? await prisma.horseStat.findMany({ where: { horseName: { in: entriesWithOdds.map((e) => e.horseName) } } })
          : []
        const fallbackRace = { ...race, trackCondition: trackCondition ?? race.trackCondition ?? undefined, date: race.date }
        const scored = localScoreHorses(
          hasEntries ? entriesWithOdds : [],
          fallbackRace,
          stats
        )
        predictions = scored
        analysis = `AIが一時的に利用できないため、蓄積データ（${horseStatCount}頭）でローカル予想を実行しました。`
      }
    } else {
      // APIキーなし → ローカルモードで試みる
      mode = 'local'
      const stats = hasEntries
        ? await prisma.horseStat.findMany({ where: { horseName: { in: entriesWithOdds.map((e) => e.horseName) } } })
        : []
      const noKeyRace = { ...race, trackCondition: trackCondition ?? race.trackCondition ?? undefined, date: race.date }
      const scored = localScoreHorses(hasEntries ? entriesWithOdds : [], noKeyRace, stats)
      predictions = scored
      if (horseStatCount < LOCAL_MODE_THRESHOLD) {
        analysis = `【学習中】現在${horseStatCount}頭分のデータが蓄積されています（目標: ${LOCAL_MODE_THRESHOLD}頭）。「自己学習」ボタンを押して学習を進めることで予測精度が向上します。`
      } else {
        analysis = `【ローカル予想モード】${horseStatCount}頭分の蓄積データで予測しています。`
      }
    }

    // 予測結果を保存
    await prisma.prediction.deleteMany({ where: { raceId } })
    if (predictions && predictions.length > 0) {
      await prisma.prediction.createMany({
        data: predictions.map((p) => ({
          raceId,
          horseNumber: p.horseNumber,
          horseName: p.horseName,
          placeRate: p.placeRate,
          rank: p.rank,
          factors: p.factors ? (p.factors as Record<string, string>) : undefined,
        })),
      })
    }

    return NextResponse.json({
      predictions,
      analysis,
      mode,
      horseStatCount,
      localModeReady: isLocalModeReady,
      localModeThreshold: LOCAL_MODE_THRESHOLD,
      race: {
        name: race.name,
        venue: race.venue,
        surface: race.surface,
        distance: race.distance,
        date: race.date,
      },
    })
  } catch (error) {
    console.error('Predict API error:', error)
    const message = error instanceof Error ? error.message : '予測の生成に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
