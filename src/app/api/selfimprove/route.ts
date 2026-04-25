import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { localScoreHorses } from '@/lib/scorer'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 300

function extractJSON(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1)
  return text
}

// === 精度統計計算 ===
async function calcAccuracyStats() {
  const racesWithBoth = await prisma.race.findMany({
    where: { predictions: { some: {} }, results: { some: {} } },
    include: {
      predictions: { orderBy: { rank: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  let completeHits = 0, halfHits = 0, misses = 0
  const rankHits: Record<number, { attempts: number; hits: number }> = {}
  for (let i = 1; i <= 5; i++) rankHits[i] = { attempts: 0, hits: 0 }

  const buckets: Record<string, { predicted: number; actual: number; label: string }> = {
    high:    { predicted: 0, actual: 0, label: '60%以上' },
    mid:     { predicted: 0, actual: 0, label: '40-59%' },
    low:     { predicted: 0, actual: 0, label: '30-39%' },
    verylow: { predicted: 0, actual: 0, label: '30%未満' },
  }

  const missExamples: string[] = []
  const raceDetails: string[] = []

  for (const r of racesWithBoth) {
    const top5Names = r.predictions.slice(0, 5).map((p) => p.horseName)
    const actualTop2 = r.results.filter((res) => res.finishPosition <= 2).map((res) => res.horseName)
    if (actualTop2.length < 2) continue

    const hits = actualTop2.filter((a) => top5Names.includes(a)).length
    if (hits === 2)      completeHits++
    else if (hits === 1) halfHits++
    else                 misses++

    for (const pred of r.predictions.slice(0, 5)) {
      const rk = pred.rank
      if (rankHits[rk]) {
        rankHits[rk].attempts++
        if (actualTop2.includes(pred.horseName)) rankHits[rk].hits++
      }
    }

    for (const pred of r.predictions) {
      const rate = pred.placeRate
      const hit = actualTop2.includes(pred.horseName) ? 1 : 0
      if (rate >= 60)      { buckets.high.predicted++;    buckets.high.actual += hit }
      else if (rate >= 40) { buckets.mid.predicted++;     buckets.mid.actual += hit }
      else if (rate >= 30) { buckets.low.predicted++;     buckets.low.actual += hit }
      else                 { buckets.verylow.predicted++; buckets.verylow.actual += hit }
    }

    const label = hits === 2 ? '完全的中' : hits === 1 ? '半的中' : '外れ'
    const top3pred = r.predictions.slice(0, 3).map((p) => p.horseName).join('/')
    raceDetails.push(`[${label}] ${r.name}: 予想[${top3pred}] 実際[${actualTop2.join('/')}]`)

    if (hits < 2) {
      const surprises = actualTop2.filter((a) => !top5Names.includes(a))
      const topStr = r.predictions.slice(0, 3).map((p) => `${p.rank}位${p.horseName}(${p.placeRate}%)`).join('/')
      missExamples.push(
        `${r.name}: 予想[${topStr}] → 実際[${actualTop2.join('/')}] 予想外:[${surprises.join('/')}]`
      )
    }
  }

  const total = racesWithBoth.length
  const accuracy = total > 0 ? Math.round((completeHits * 2 + halfHits) / (total * 2) * 1000) / 10 : 0
  return { total, accuracy, completeHits, halfHits, misses, rankHits, buckets, missExamples, raceDetails }
}

// GET: 現在の精度統計を返す
export async function GET() {
  try {
    const stats = await calcAccuracyStats()
    return NextResponse.json(stats)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST: フルサイクル実行
// body: { reset?: boolean }  reset=trueで既存予想をクリアしてから再生成
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const doReset = body.reset === true

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY
  if (!hasApiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEYが必要です' }, { status: 400 })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const log: string[] = []
  const today = new Date()

  // ========== Phase 1: 2023〜2025年G1レースに実際の結果と出走馬をシード ==========
  const knowledgeCutoff = new Date('2025-08-01')

  const racesNeedingData = await prisma.race.findMany({
    where: {
      date: { lt: knowledgeCutoff },
      grade: 'G1',
      results: { none: {} },
    },
    orderBy: { date: 'asc' },  // 古い順（信頼性の高いものから）
    take: 60,
  })

  log.push(`=== Phase 1: データシード ===`)
  log.push(`対象レース: ${racesNeedingData.length}件`)

  let seededCount = 0
  const seededIds: string[] = []

  // Step 1a: まず着順（上位5着）だけを取得（レスポンスを小さく保つ）
  const RESULT_BATCH = 8
  type ResultItem = { raceName: string; results: Array<{ finishPosition: number; horseName: string }> }
  const resultMap = new Map<string, ResultItem>()

  for (let i = 0; i < racesNeedingData.length; i += RESULT_BATCH) {
    const batch = racesNeedingData.slice(i, i + RESULT_BATCH)
    const raceList = batch
      .map((r) => `${r.name}（${r.date.toISOString().slice(0, 10)}）`)
      .join('\n')

    const prompt = `以下のJRA G1レースの着順上位5頭のみ教えてください。知っているレースだけ回答してください。

${raceList}

以下のJSON形式のみで返してください：
{"races":[{"raceName":"有馬記念2024","results":[{"finishPosition":1,"horseName":"ドウデュース"},{"finishPosition":2,"horseName":"シャフリヤール"},{"finishPosition":3,"horseName":"ダノンデサイル"},{"finishPosition":4,"horseName":"アーバンシック"},{"finishPosition":5,"horseName":"ジャスティンパレス"}]}]}`

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: `JRA競馬専門家。確実に知っている過去G1レースの着順を正確なJSON形式で返してください。`,
        messages: [{ role: 'user', content: prompt }],
      })
      const ct = msg.content[0]
      if (ct.type !== 'text') continue
      const parsed = JSON.parse(extractJSON(ct.text.trim())) as { races?: ResultItem[] }
      if (!Array.isArray(parsed.races)) continue

      for (const rd of parsed.races) {
        if (!rd.raceName || !Array.isArray(rd.results) || rd.results.length < 2) continue
        // 名前の前後一致でマッチ
        const matched = batch.find((r) => r.name === rd.raceName || r.name.startsWith(rd.raceName.replace(/\d{4}$/, '').trim()))
        if (matched) resultMap.set(matched.id, { raceName: matched.name, results: rd.results })
      }
      log.push(`  着順取得バッチ${Math.floor(i/RESULT_BATCH)+1}: ${parsed.races.length}件取得`)
    } catch (e) {
      log.push(`  着順バッチ${Math.floor(i/RESULT_BATCH)+1}失敗: ${String(e).slice(0, 60)}`)
    }
  }

  log.push(`着順データ取得: ${resultMap.size}レース分`)

  // Step 1b: 着順が取れたレースについて出走全馬リストを取得
  const resultRaceIds = Array.from(resultMap.keys())
  const ENTRY_BATCH = 5
  type EntryItem = { raceName: string; entries: Array<{ horseNumber: number; horseName: string; jockey?: string; age?: number }> }
  const entryMap = new Map<string, EntryItem>()

  for (let i = 0; i < resultRaceIds.length; i += ENTRY_BATCH) {
    const ids = resultRaceIds.slice(i, i + ENTRY_BATCH)
    const batchRaces = racesNeedingData.filter((r) => ids.includes(r.id))
    const raceList = batchRaces
      .map((r) => `${r.name}（${r.date.toISOString().slice(0, 10)}、${r.venue}、${r.surface}${r.distance}m）`)
      .join('\n')

    const prompt = `以下のJRA G1レースの出走全馬を馬番・馬名・騎手・年齢で教えてください。

${raceList}

以下のJSON形式のみで返してください：
{"races":[{"raceName":"有馬記念2024","entries":[{"horseNumber":1,"horseName":"ドウデュース","jockey":"武豊","age":5}]}]}`

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: `JRA競馬専門家。過去G1レースの出走全馬を正確なJSON形式で返してください。`,
        messages: [{ role: 'user', content: prompt }],
      })
      const ct = msg.content[0]
      if (ct.type !== 'text') continue
      const parsed = JSON.parse(extractJSON(ct.text.trim())) as { races?: EntryItem[] }
      if (!Array.isArray(parsed.races)) continue

      for (const ed of parsed.races) {
        if (!ed.raceName || !Array.isArray(ed.entries)) continue
        const matched = batchRaces.find((r) => r.name === ed.raceName || r.name.startsWith(ed.raceName.replace(/\d{4}$/, '').trim()))
        if (matched) entryMap.set(matched.id, { raceName: matched.name, entries: ed.entries })
      }
      log.push(`  出走馬取得バッチ${Math.floor(i/ENTRY_BATCH)+1}: ${parsed.races.length}件取得`)
    } catch (e) {
      log.push(`  出走馬バッチ${Math.floor(i/ENTRY_BATCH)+1}失敗: ${String(e).slice(0, 60)}`)
    }
  }

  // Step 1c: 着順データをDBに保存
  for (const [raceId, rd] of Array.from(resultMap)) {
    const race = racesNeedingData.find((r) => r.id === raceId)
    if (!race) continue

    // エントリー保存
    const entryData = entryMap.get(raceId)
    let entrySaved = 0
    if (entryData?.entries) {
      for (const e of entryData.entries) {
        if (!e.horseName?.trim() || !e.horseNumber) continue
        try {
          await prisma.raceEntry.create({
            data: {
              raceId, horseNumber: Number(e.horseNumber),
              horseName: String(e.horseName).trim(),
              jockey: e.jockey ?? null, age: e.age ? Number(e.age) : null,
            },
          })
          entrySaved++
        } catch { /* duplicate */ }
      }
    }

    // 結果保存
    let resultSaved = 0
    for (const res of rd.results.slice(0, 5)) {
      if (!res.horseName?.trim() || !res.finishPosition) continue
      const hn = entryData?.entries?.find((e) => e.horseName === res.horseName)?.horseNumber
        ?? (90 + Number(res.finishPosition))
      try {
        await prisma.raceResult.create({
          data: {
            raceId, finishPosition: Number(res.finishPosition),
            horseNumber: Number(hn), horseName: String(res.horseName).trim(),
          },
        })
        resultSaved++
      } catch { /* duplicate */ }
    }

    if (resultSaved >= 2) {
      seededIds.push(raceId)
      seededCount++
      log.push(`  ✓ ${race.name}: 出走${entrySaved}頭, 結果${resultSaved}件`)
    }
  }

  log.push(`Phase 1完了: ${seededCount}レースにデータ追加`)

  // ========== Phase 2: HorseStatを結果データで再構築（recentForm付き）==========
  log.push(`\n=== Phase 2: HorseStat再構築 ===`)

  if (seededCount > 0) {
    const allRacesForStats = await prisma.race.findMany({
      where: { results: { some: {} } },
      include: { results: { orderBy: { finishPosition: 'asc' } } },
      orderBy: { date: 'asc' },
    })

    const { buildHorseStatsFromResults, mergeStatData, mergeRecentForm } = await import('@/lib/horseStats')

    const freshStats = buildHorseStatsFromResults(
      allRacesForStats.map((r) => ({
        name: r.name, grade: r.grade, venue: r.venue, surface: r.surface, distance: r.distance, date: r.date,
        results: r.results.map((res) => ({ horseName: res.horseName, finishPosition: res.finishPosition })),
      }))
    )

    if (freshStats.length > 0) {
      // 既存HorseStatに累積マージ（Claude学習分を保持しつつ実データで上書き）
      let updated = 0
      for (const hs of freshStats) {
        const existing = await prisma.horseStat.findUnique({ where: { horseName: hs.horseName } })
        if (existing) {
          await prisma.horseStat.update({
            where: { horseName: hs.horseName },
            data: {
              // 実データ優先: distanceData/venueData/surfaceDataは実測値で上書き
              distanceData: mergeStatData(
                existing.distanceData as Record<string, { races: number; places: number }>,
                hs.distanceData
              ),
              venueData: mergeStatData(
                existing.venueData as Record<string, { races: number; places: number }>,
                hs.venueData
              ),
              surfaceData: mergeStatData(
                existing.surfaceData as Record<string, { races: number; places: number }>,
                hs.surfaceData
              ),
              recentForm: mergeRecentForm(hs.recentForm, existing.recentForm),
              lastRaceDate: hs.lastRaceDate > (existing.lastRaceDate ?? new Date(0)) ? hs.lastRaceDate : existing.lastRaceDate,
            },
          })
        } else {
          await prisma.horseStat.create({
            data: {
              horseName: hs.horseName,
              totalRaces: hs.totalRaces, totalPlaces: hs.totalPlaces,
              g1Races: hs.g1Races, g1Places: hs.g1Places,
              distanceData: hs.distanceData, venueData: hs.venueData, surfaceData: hs.surfaceData,
              lastRaceDate: hs.lastRaceDate, recentForm: hs.recentForm ?? null,
            },
          })
        }
        updated++
      }
      log.push(`HorseStat更新: ${updated}頭（実測distanceData/recentForm付き）`)
    }
  }

  // ========== Phase 3: 過去レースの予想生成 ==========
  log.push(`\n=== Phase 3: 予想生成 ===`)

  // リセットオプション: 既存予想を削除して再生成
  if (doReset) {
    const pastRaceIds = (await prisma.race.findMany({
      where: { date: { lt: today }, results: { some: {} } },
      select: { id: true },
    })).map((r) => r.id)
    const deleted = await prisma.prediction.deleteMany({ where: { raceId: { in: pastRaceIds } } })
    log.push(`既存予想削除: ${deleted.count}件`)
  }

  const racesToPredict = await prisma.race.findMany({
    where: {
      date: { lt: today },
      results: { some: { finishPosition: { lte: 2 } } },
      predictions: { none: {} },
    },
    include: {
      entries: { orderBy: { horseNumber: 'asc' } },
      results: { orderBy: { finishPosition: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  log.push(`予想生成対象: ${racesToPredict.length}レース`)

  let predictedCount = 0
  const predictionLog: string[] = []

  for (const race of racesToPredict) {
    // エントリーがあればエントリーを、なければ結果から全馬を仮エントリーとして使用
    const rawEntries = race.entries.length > 0
      ? race.entries
      : race.results.map((r) => ({
          horseNumber: r.horseNumber,
          horseName: r.horseName,
          age: r.age,
          jockey: r.jockey,
          horseWeight: r.horseWeight,
        }))

    if (rawEntries.length === 0) continue

    const horseNames = rawEntries.map((e) => e.horseName)
    const stats = await prisma.horseStat.findMany({ where: { horseName: { in: horseNames } } })

    const entries = rawEntries.map((e) => ({
      horseNumber: e.horseNumber,
      horseName: e.horseName,
      age: e.age ?? null,
      jockey: e.jockey ?? null,
      trainer: (e as { trainer?: string | null }).trainer ?? null,
      horseWeight: e.horseWeight ?? null,
      weightChange: null as number | null,
    }))

    const scored = localScoreHorses(
      entries,
      { grade: race.grade, distance: race.distance, venue: race.venue, surface: race.surface },
      stats
    )

    if (scored.length === 0) continue

    await prisma.prediction.createMany({
      data: scored.map((p) => ({
        raceId: race.id,
        horseNumber: p.horseNumber,
        horseName: p.horseName,
        placeRate: p.placeRate,
        rank: p.rank,
        factors: p.factors as object,
      })),
    })

    const actualTop2 = race.results.filter((r) => r.finishPosition <= 2).map((r) => r.horseName)
    const top5 = scored.map((p) => p.horseName)
    const hits = actualTop2.filter((n) => top5.includes(n)).length
    const label = hits === 2 ? '完全' : hits === 1 ? '半的中' : '外れ'
    predictionLog.push(`[${label}] ${race.name}: 予想[${top5.slice(0, 3).join('/')}] 実際[${actualTop2.join('/')}]`)
    predictedCount++
  }

  log.push(`予想生成完了: ${predictedCount}レース`)

  // ========== Phase 4: 精度統計 ==========
  log.push(`\n=== Phase 4: 精度分析 ===`)
  const accStats = await calcAccuracyStats()
  log.push(`照合レース数: ${accStats.total}`)
  log.push(`通算的中率: ${accStats.accuracy}%`)
  log.push(`完全的中: ${accStats.completeHits}件 / 半的中: ${accStats.halfHits}件 / 外れ: ${accStats.misses}件`)

  // ========== Phase 5: Claude分析 → AlgorithmConfig更新 ==========
  log.push(`\n=== Phase 5: アルゴリズム改善 ===`)

  let analysisText = ''
  let algorithmUpdated = false
  let improvements: string[] = []

  if (accStats.total >= 5) {
    try {
      const currentConfig = await prisma.algorithmConfig.findFirst({
        where: { isActive: true },
        orderBy: { version: 'desc' },
      })

      const calibLines = Object.entries(accStats.buckets)
        .filter(([, v]) => v.predicted > 0)
        .map(([, v]) => {
          const actual = Math.round(v.actual / v.predicted * 100)
          const labelNum = v.label === '60%以上' ? 65 : v.label === '40-59%' ? 50 : v.label === '30-39%' ? 35 : 20
          const diff = actual - labelNum
          const arrow = diff > 8 ? '↑過小評価（もっと高く設定すべき）' : diff < -8 ? '↓過大評価（設定を下げるべき）' : '概ね正確'
          return `予想${v.label}: ${v.predicted}頭中${v.actual}頭が実際に連対(実際${actual}%) ${arrow}`
        }).join('\n')

      const rankLines = Object.entries(accStats.rankHits)
        .filter(([, v]) => v.attempts > 0)
        .map(([rank, v]) => {
          const pct = Math.round(v.hits / v.attempts * 100)
          const ideal = rank === '1' ? 50 : rank === '2' ? 40 : rank === '3' ? 30 : rank === '4' ? 20 : 10
          const gap = pct - ideal
          return `予想${rank}位: ${v.attempts}回中${v.hits}回的中(${pct}%)${gap > 10 ? ' ✓信頼性高' : gap < -10 ? ' ✗信頼性低' : ''}`
        }).join('\n')

      const analysisPrompt = `あなたはJRA競馬予想AIの自己改善システムです。${accStats.total}レースの予想結果を徹底分析してください。

━━━━ 累積精度統計 ━━━━
照合レース数: ${accStats.total}件
通算的中率: ${accStats.accuracy}%
完全的中（2/2）: ${accStats.completeHits}件（${Math.round(accStats.completeHits/accStats.total*100)}%）
半的中（1/2）: ${accStats.halfHits}件（${Math.round(accStats.halfHits/accStats.total*100)}%）
外れ（0/2）: ${accStats.misses}件（${Math.round(accStats.misses/accStats.total*100)}%）

【連対率キャリブレーション分析】
${calibLines || 'データ不足'}

【予想順位別的中率（信頼性分析）】
${rankLines || 'データ不足'}

【代表的な外れパターン（根本原因分析用）】
${accStats.missExamples.slice(0, 10).join('\n') || 'なし'}

【全レース詳細（最新30件）】
${accStats.raceDetails.slice(-30).join('\n')}

【現在のアルゴリズムルール】
${(currentConfig?.rules ?? '基本ルール未設定').slice(0, 700)}

━━━━ 分析・改善指示 ━━━━
以下を分析して改善策を提案してください：
1. 連対率が過大/過小評価されているパターンの根本原因
2. 予想順位1〜5位の信頼性のズレ（どの順位が当たりやすく、どれが外れやすいか）
3. 外れパターンに共通する馬の特徴（人気薄/G1実績なし/初コース等）
4. 上記を反映した改善ルール

以下のJSON形式のみで返してください：
{
  "analysis": "根本原因の詳細分析（4〜6文）",
  "improvements": ["改善点1: 具体的な修正", "改善点2", "改善点3", "改善点4"],
  "updatedRules": "改善後の予想アルゴリズムルール（600文字以内）",
  "estimatedAccuracy": 65.0
}`

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: `あなたはJRA競馬予想の自己改善AIです。累積予想データを統計的に分析し、連対率推定アルゴリズムの欠陥を特定して改善します。必ずJSON形式のみで返答してください。`,
        messages: [{ role: 'user', content: analysisPrompt }],
      })

      const content = message.content[0]
      if (content.type === 'text') {
        const json = JSON.parse(extractJSON(content.text.trim()))
        analysisText = json.analysis ?? ''
        improvements = Array.isArray(json.improvements) ? json.improvements : []

        if (json.updatedRules && currentConfig) {
          await prisma.algorithmConfig.updateMany({ where: { isActive: true }, data: { isActive: false } })
          await prisma.algorithmConfig.create({
            data: {
              version: (currentConfig.version ?? 0) + 1,
              isActive: true,
              rules: json.updatedRules,
              insights: JSON.stringify(improvements),
              analyzedCount: (currentConfig.analyzedCount ?? 0) + predictedCount,
              accuracy: json.estimatedAccuracy ?? accStats.accuracy,
            },
          })
          algorithmUpdated = true
          log.push(`AlgorithmConfig v${(currentConfig.version ?? 0) + 1}に更新`)
        }
      }
    } catch (e) {
      log.push(`Claude分析失敗: ${String(e).slice(0, 100)}`)
    }
  } else {
    log.push(`照合データ不足（${accStats.total}件 < 5件）のためアルゴリズム更新をスキップ`)
  }

  return NextResponse.json({
    log,
    seededCount,
    predictedCount,
    predictionLog,
    accuracyStats: {
      total: accStats.total,
      accuracy: accStats.accuracy,
      completeHits: accStats.completeHits,
      halfHits: accStats.halfHits,
      misses: accStats.misses,
    },
    rankHits: accStats.rankHits,
    calibration: accStats.buckets,
    missExamples: accStats.missExamples,
    raceDetails: accStats.raceDetails,
    analysis: analysisText,
    improvements,
    algorithmUpdated,
  })
}
