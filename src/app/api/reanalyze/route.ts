import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildHorseStatsFromResults, type HorseStatData } from '@/lib/horseStats'
import { rebuildCalibrationCurve } from '@/lib/localAutoLearn'
import { format } from 'date-fns'
import { ja } from 'date-fns/locale'
import Anthropic from '@anthropic-ai/sdk'

// §A 全馬intervalDataを集計してビン別連対率を算出
function computeGlobalIntervalBaseline(stats: HorseStatData[]): Record<string, number> {
  const bins: Record<string, { races: number; places: number }> = {}
  for (const hs of stats) {
    for (const [bin, data] of Object.entries(hs.intervalData)) {
      if (!bins[bin]) bins[bin] = { races: 0, places: 0 }
      bins[bin].races  += data.races
      bins[bin].places += data.places
    }
  }
  const baseline: Record<string, number> = {}
  for (const [bin, data] of Object.entries(bins)) {
    if (data.races >= 10) baseline[bin] = data.places / data.races
  }
  return baseline
}

export const maxDuration = 300

function extractJSON(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1)
  return text
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))

    // action=reset: 全レースを未分析に戻す
    if (body.action === 'reset') {
      const updated = await prisma.race.updateMany({
        where: { analyzed: true },
        data: { analyzed: false },
      })
      return NextResponse.json({
        reset: true,
        resetCount: updated.count,
        message: `${updated.count}件のレースを未分析にリセットしました。「全件一括学習」を実行して馬データを再構築してください。`,
      })
    }

    const hasApiKey = !!process.env.ANTHROPIC_API_KEY

    // ① 全レースのRaceResultからHorseStatを再構築（チャンク処理・全グレード対象）
    const CHUNK = 5000
    const allStatsMap = new Map<string, HorseStatData>()

    let skipCount = 0
    while (true) {
      const chunk = await prisma.race.findMany({
        take: CHUNK,
        skip: skipCount,
        orderBy: { id: 'asc' },
        include: {
          results: {
            where: { finishPosition: { not: null } },
            orderBy: { finishPosition: 'asc' },
          },
        },
      })
      if (chunk.length === 0) break
      skipCount += chunk.length

      const chunkStats = buildHorseStatsFromResults(
        chunk.map((r: typeof chunk[0]) => ({
          name: r.name,
          grade: r.grade,
          venue: r.venue,
          surface: r.surface,
          distance: r.distance,
          date: r.date,
          trackCondition: r.trackCondition ?? null,
          results: r.results.map((res: typeof chunk[0]['results'][0]) => ({
            horseName: res.horseName,
            finishPosition: res.finishPosition ?? 99,
            popularity: res.popularity ?? null,
            horseWeight: res.horseWeight ?? null,
          })),
        }))
      )

      for (const s of chunkStats) {
        const ex = allStatsMap.get(s.horseName)
        if (!ex) {
          allStatsMap.set(s.horseName, s)
        } else {
          // マージ: 集計系は加算、最終レース日は最新を採用
          ex.totalRaces  += s.totalRaces
          ex.totalPlaces += s.totalPlaces
          ex.g1Races  += s.g1Races;  ex.g1Places  += s.g1Places
          ex.g2Races  += s.g2Races;  ex.g2Places  += s.g2Places
          ex.g3Races  += s.g3Races;  ex.g3Places  += s.g3Places
          for (const [k, v] of Object.entries(s.distanceData))  ex.distanceData[k]  = ex.distanceData[k]  ? { races: ex.distanceData[k].races  + v.races,  places: ex.distanceData[k].places  + v.places  } : v
          for (const [k, v] of Object.entries(s.venueData))     ex.venueData[k]     = ex.venueData[k]     ? { races: ex.venueData[k].races     + v.races,  places: ex.venueData[k].places     + v.places  } : v
          for (const [k, v] of Object.entries(s.surfaceData))   ex.surfaceData[k]   = ex.surfaceData[k]   ? { races: ex.surfaceData[k].races   + v.races,  places: ex.surfaceData[k].places   + v.places  } : v
          for (const [k, v] of Object.entries(s.raceNameData))  ex.raceNameData[k]  = ex.raceNameData[k]  ? { races: ex.raceNameData[k].races  + v.races,  places: ex.raceNameData[k].places  + v.places  } : v
          for (const [k, v] of Object.entries(s.trackCondData)) ex.trackCondData[k] = ex.trackCondData[k] ? { races: ex.trackCondData[k].races + v.races,  places: ex.trackCondData[k].places + v.places  } : v
          for (const [k, v] of Object.entries(s.intervalData))  ex.intervalData[k]  = ex.intervalData[k]  ? { races: ex.intervalData[k].races  + v.races,  places: ex.intervalData[k].places  + v.places  } : v
          for (const [k, v] of Object.entries(s.courseDistData)) ex.courseDistData[k] = ex.courseDistData[k] ? { races: ex.courseDistData[k].races + v.races, places: ex.courseDistData[k].places + v.places } : v
          if (s.lastRaceDate > ex.lastRaceDate) {
            ex.lastRaceDate = s.lastRaceDate
            ex.lastRacePopularity = s.lastRacePopularity
            ex.recentForm   = s.recentForm
            ex.recentGrades = s.recentGrades
            ex.recentPops   = s.recentPops
          }
          if (s.avgHorseWeight != null) {
            const ws = (ex.weightSamples ?? 0) + (s.weightSamples ?? 0)
            if (ws > 0) {
              ex.avgHorseWeight = ((ex.avgHorseWeight ?? s.avgHorseWeight ?? 0) * (ex.weightSamples ?? 0) + s.avgHorseWeight * (s.weightSamples ?? 0)) / ws
              ex.weightSamples = ws
            }
          }
        }
      }
    }

    const freshStats = Array.from(allStatsMap.values())
    // allRaces は後段の Claude 分析用に別途取得
    const allRaces = await prisma.race.findMany({
      include: { results: { orderBy: { finishPosition: 'asc' } } },
      orderBy: { date: 'asc' },
    })

    // RaceResult が存在する場合のみ HorseStat を再構築
    let horsesSaved = 0
    if (freshStats.length > 0) {
      await prisma.horseStat.deleteMany({})
      for (const hs of freshStats) {
        try {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces,
              totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races,
              g1Places: hs.g1Places,
              g2Races: hs.g2Races,
              g2Places: hs.g2Places,
              g3Races: hs.g3Races,
              g3Places: hs.g3Places,
              distanceData: hs.distanceData,
              venueData: hs.venueData,
              surfaceData: hs.surfaceData,
              raceNameData: hs.raceNameData,
              intervalData:   hs.intervalData,
              courseDistData: hs.courseDistData,
              avgHorseWeight: hs.avgHorseWeight ?? null,
              weightSamples:  hs.weightSamples ?? 0,
              lastRaceDate:   hs.lastRaceDate,
              lastRacePopularity: hs.lastRacePopularity ?? null,
              recentForm: hs.recentForm ?? null,
              recentGrades: hs.recentGrades ?? null,
              recentPops: hs.recentPops ?? null,
            },
          })
          horsesSaved++
        } catch { /* 個別エラーはスキップ */ }
      }
    }

    const horseStatCount = await prisma.horseStat.count()

    // §A: globalIntervalBaseline を計算（freshStats から集計）
    const globalIntervalBaseline = freshStats.length > 0
      ? computeGlobalIntervalBaseline(freshStats)
      : {}

    // ② Claude APIがある場合: 全分析済みレースを総括して予想ルールを精緻化
    let refinedRules = ''
    let refinedAccuracy = 0
    let refinedSummary = 'HorseStatをRaceResultから完全再構築しました。'

    if (hasApiKey) {
      const analyzedRaces = allRaces.filter((r) => r.analyzed && r.results.length > 0)

      // 分析済みレースをサマリ形式に変換（最大120件）
      const racesSummary = analyzedRaces
        .slice(0, 120)
        .map((r) => {
          const dateStr = format(new Date(r.date), 'yyyy年M月d日', { locale: ja })
          const top3 = r.results
            .slice(0, 3)
            .map((res) => `${res.finishPosition}着:${res.horseName}${res.popularity ? `(${res.popularity}人気)` : ''}`)
            .join(' ')
          return `${r.name}(${r.grade}/${r.venue}/${r.surface}${r.distance}m/${dateStr}) ${top3}`
        })
        .join('\n')

      // 予想照合: Prediction と RaceResult の両方があるレースで実際の精度を計算
      const racesWithBoth = await prisma.race.findMany({
        where: {
          predictions: { some: {} },
          results: { some: {} },
        },
        include: {
          predictions: { orderBy: { rank: 'asc' }, take: 5 },
          results: { orderBy: { finishPosition: 'asc' }, take: 3 },
        },
        orderBy: { date: 'desc' },
        take: 30,
      })

      let accuracySection = ''
      if (racesWithBoth.length > 0) {
        let totalHits = 0
        const missDetails: string[] = []
        for (const r of racesWithBoth) {
          const predictedNames = r.predictions.map((p) => p.horseName)
          const actualTop2 = r.results.filter((res) => res.finishPosition != null && res.finishPosition <= 2).map((res) => res.horseName)
          const hits = actualTop2.filter((n) => predictedNames.includes(n)).length
          totalHits += hits
          if (hits < 2) {
            const surprises = actualTop2.filter((n) => !predictedNames.includes(n))
            missDetails.push(
              `${r.name}: 予想外の連対=[${surprises.join(',')}] 予想上位=[${predictedNames.slice(0, 3).join(',')}]`
            )
          }
        }
        const actualAccuracy = (totalHits / (racesWithBoth.length * 2)) * 100
        accuracySection = `
【実際の予想精度（${racesWithBoth.length}件照合済み）】
実績連対的中率: ${actualAccuracy.toFixed(1)}%
主な外れパターン（改善ヒント）:
${missDetails.slice(0, 8).join('\n')}`
      }

      const currentConfig = await prisma.algorithmConfig.findFirst({
        where: { isActive: true },
        orderBy: { version: 'desc' },
      })

      const prompt = `以下のデータを総合して、連対率予測の精度を最大化する予想ルールを再構築してください。
${accuracySection}

【全レース結果サマリ（最新${Math.min(120, analyzedRaces.length)}件）】
${racesSummary || '（レース結果データなし。過去の予想照合データを中心に分析）'}

【現在のルール】
${(currentConfig?.rules ?? '初期設定').slice(0, 800)}

全データを分析して以下のJSON形式のみで返してください：

{
  "refinedRules": "精緻化した予想ルール（600文字以内）",
  "keyFindings": ["発見1", "発見2", "発見3", "発見4", "発見5"],
  "estimatedAccuracy": 68.5,
  "summary": "再検証で得られた主要な知見（2-3文）"
}`

      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: `あなたはJRA競馬の機械学習システムです。全レースデータを統計的に分析し、連対率予測ルールを精緻化します。必ずJSON形式のみで返答してください。`,
          messages: [{ role: 'user', content: prompt }],
        })

        const content = message.content[0]
        if (content.type === 'text') {
          const json = JSON.parse(extractJSON(content.text.trim()))
          refinedRules = json.refinedRules ?? ''
          refinedAccuracy = json.estimatedAccuracy ?? 0
          refinedSummary = json.summary ?? refinedSummary

          if (refinedRules) {
            const newVersion = (currentConfig?.version ?? 0) + 1
            await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
            await prisma.algorithmConfig.create({
              data: {
                version: newVersion,
                isActive: true,
                rules: refinedRules,
                insights: JSON.stringify(json.keyFindings ?? []),
                analyzedCount: analyzedRaces.length + racesWithBoth.length,
                accuracy: refinedAccuracy,
              },
            })
          }
        }
      } catch (e) {
        console.warn('Reanalyze Claude call failed:', e)
        refinedSummary = `HorseStatを${horsesSaved}頭分再構築しました（Claude API呼び出し失敗）。`
      }
    }

    // §A: globalIntervalBaseline を active config の insights にマージ保存
    if (Object.keys(globalIntervalBaseline).length > 0) {
      try {
        const activeConfig = await prisma.algorithmConfig.findFirst({
          where: { isActive: true },
          orderBy: { version: 'desc' },
        })
        if (activeConfig) {
          let ins: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(activeConfig.insights as string ?? '{}')
            ins = Array.isArray(parsed) ? { keyFindings: parsed } : (parsed as Record<string, unknown>)
          } catch { /* fallback to empty */ }
          ins.globalIntervalBaseline = globalIntervalBaseline
          await prisma.algorithmConfig.update({
            where: { id: activeConfig.id },
            data: { insights: JSON.stringify(ins) },
          })
        }
      } catch (e) {
        console.warn('globalIntervalBaseline save failed:', e)
      }
    }

    // §E: キャリブレーション曲線を再構築
    await rebuildCalibrationCurve()

    return NextResponse.json({
      horsesSaved,
      horseStatCount,
      totalRaces: allRaces.length,
      analyzedRaces: allRaces.filter((r) => r.analyzed).length,
      refinedRules,
      refinedAccuracy,
      summary: refinedSummary,
      localModeThreshold: 10000,
      localModeReady: horseStatCount >= 10000,
    })
  } catch (error) {
    console.error('Reanalyze API error:', error)
    const message = error instanceof Error ? error.message : '再検証に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET() {
  try {
    const totalRaces = await prisma.race.count()
    const analyzedRaces = await prisma.race.count({ where: { analyzed: true } })
    const horseStatCount = await prisma.horseStat.count()
    const config = await prisma.algorithmConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    })
    return NextResponse.json({
      totalRaces,
      analyzedRaces,
      horseStatCount,
      accuracy: config?.accuracy ?? null,
      version: config?.version ?? 0,
    })
  } catch (error) {
    console.error('Reanalyze GET error:', error)
    return NextResponse.json({ error: 'ステータス取得失敗' }, { status: 500 })
  }
}
