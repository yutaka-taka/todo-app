import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

function extractJSON(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1)
  return text
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error = new Error('unknown')
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

export interface PredictionEntry {
  horseNumber: number
  horseName: string
  jockey?: string | null
  age?: number | null
  sex?: string | null
  weight?: number | null
  horseWeight?: number | null
  weightChange?: number | null
}

export interface PredictionFactor {
  recentForm?: string
  distanceSuitability?: string
  courseRecord?: string
  jockeyStats?: string
  reason?: string
}

export interface PredictionItem {
  rank: number
  horseNumber: number | null
  horseName: string
  placeRate: number
  factors?: PredictionFactor
}

export interface PredictionResponse {
  predictions: PredictionItem[]
  analysis: string
}

export async function generatePrediction(params: {
  raceName: string
  raceDate: string
  venue: string
  surface: string
  distance: number
  grade: string
  entries: PredictionEntry[]
  algorithmRules: string
}): Promise<PredictionResponse> {
  const { raceName, raceDate, venue, surface, distance, grade, entries } = params
  const algorithmRules = params.algorithmRules.length > 1500
    ? params.algorithmRules.slice(0, 1500) + '\n...(以降省略)'
    : params.algorithmRules

  const entriesSection =
    entries.length > 0
      ? `【確定出走馬一覧】\n${entries
          .map((e) => {
            const weightInfo = (e.horseWeight != null || e.weightChange != null)
              ? ` 体重:${e.horseWeight ?? '?'}kg${e.weightChange != null ? `(前走比${e.weightChange > 0 ? '+' : ''}${e.weightChange}kg)` : ''}`
              : ''
            return `${e.horseNumber}番 ${e.horseName}${e.jockey ? ` 騎手:${e.jockey}` : ''}${e.age ? ` ${e.age}歳` : ''}${e.sex || ''}${weightInfo}`
          })
          .join('\n')}`
      : `【出走馬】\n出走馬はまだ確定していません。このレースの過去の出走傾向や、現在活躍中の有力馬から上位候補を独自に選定して予測してください。`

  const prompt = `以下のG1レースについて、各馬の連対率（2着以内に入る確率）を予測してください。

【レース情報】
レース名: ${raceName}
開催日: ${raceDate}
競馬場: ${venue}
コース: ${surface}${distance}m
グレード: ${grade}

${entriesSection}

【予想アルゴリズムルール】
${algorithmRules}

連対率が高い順に上位5頭を以下のJSON形式のみで返してください。JSON以外のテキストは一切含めないでください：

{
  "predictions": [
    {
      "rank": 1,
      "horseNumber": 7,
      "horseName": "馬名",
      "placeRate": 68.5,
      "factors": {
        "recentForm": "直近成績の評価",
        "distanceSuitability": "距離適性の評価",
        "courseRecord": "コース実績の評価",
        "jockeyStats": "騎手の評価",
        "reason": "総合的な予想根拠（2-3文）"
      }
    }
  ],
  "analysis": "レース全体の展望と見どころ（2-3文）"
}

重要: placeRateは30〜80の範囲。必ずJSON形式のみで返答。`

  return withRetry(async () => {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: `あなたはJRA競馬の専門アナリストです。各馬の連対率を精密に算出します。必ずJSON形式のみで返答してください。`,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = message.content[0]
    if (content.type !== 'text') throw new Error('予期しないレスポンス形式')

    const jsonText = extractJSON(content.text.trim())
    return JSON.parse(jsonText) as PredictionResponse
  })
}

// ---- 自己学習用 ----

export interface LearnedInsight {
  category: string
  insight: string
  confidence: number
  applicableCases: string
}

// 馬別基本成績（シンプルな5フィールドのみ）
export interface SimpleHorseStat {
  horseName: string
  totalRaces: number
  totalPlaces: number
  g1Races: number
  g1Places: number
}

export interface LearningResult {
  horseStats: SimpleHorseStat[]
  newInsights: LearnedInsight[]
  updatedRules: string
  keyPatterns: string[]
  estimatedAccuracy: number
  summary: string
}

export interface UpcomingHorseStat {
  horseName: string
  totalRaces: number
  totalPlaces: number
  g1Races: number
  g1Places: number
  recentForm: string
  recentNote: string
}

export async function refreshUpcomingRaceHorses(params: {
  raceName: string
  venue: string
  surface: string
  distance: number
  grade: string
  raceDate: string
  horseNames: string[]
}): Promise<UpcomingHorseStat[]> {
  const { raceName, venue, surface, distance, grade, raceDate, horseNames } = params

  const prompt = `以下の週末G1レースに出走する馬について、あなたの知識に基づいた通算成績と直近フォームを教えてください。

【レース】${raceName}（${raceDate} ${venue} ${surface}${distance}m ${grade}）

【出走馬】${horseNames.join('、')}

以下のJSON形式のみで返してください（JSON以外のテキストは一切含めないでください）：

{
  "horses": [
    {
      "horseName": "馬名",
      "totalRaces": 20,
      "totalPlaces": 12,
      "g1Races": 5,
      "g1Places": 3,
      "recentForm": "1-2-1-3-2",
      "recentNote": "直近フォームの一言評価"
    }
  ]
}

注意:
- 知識がない馬は省略してください
- recentFormは最近5走の着順（新しい順、不明な場合は空文字）
- totalRacesは通算出走数（不明な場合はG1出走数から推定）`

  return withRetry(async () => {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `あなたはJRA競馬の専門アナリストです。出走馬の最新情報をJSON形式のみで返答してください。`,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = message.content[0]
    if (content.type !== 'text') throw new Error('予期しないレスポンス形式')

    const jsonText = extractJSON(content.text.trim())
    const result = JSON.parse(jsonText) as { horses: UpcomingHorseStat[] }
    return Array.isArray(result.horses) ? result.horses : []
  })
}

export async function analyzeRacesForLearning(params: {
  racesData: string
  currentRules: string
}): Promise<LearningResult> {
  // 学習を繰り返すとrulesが肥大化するため切り詰め
  const currentRules = params.currentRules.length > 1200
    ? params.currentRules.slice(0, 1200) + '\n...(以降省略)'
    : params.currentRules

  const prompt = `以下の過去重賞レースを分析し、連対率予測アルゴリズムを改善してください。

【分析対象レース】
${params.racesData}

【現在の予想ルール】
${currentRules}

以下のJSON形式のみで返してください（JSON以外のテキストは一切含めないでください）：

{
  "horseStats": [
    {"horseName": "馬名", "totalRaces": 20, "totalPlaces": 12, "g1Races": 5, "g1Places": 3}
  ],
  "newInsights": [
    {"category": "カテゴリ", "insight": "学習知見", "confidence": 0.85, "applicableCases": "適用条件"}
  ],
  "updatedRules": "改善された予想ルール（500文字以内）",
  "keyPatterns": ["パターン1", "パターン2", "パターン3"],
  "estimatedAccuracy": 65.5,
  "summary": "今回の学習で得られた主要な知見（1-2文）"
}

注意事項:
- horseStatsは必須です。各レースの上位5頭（1〜5着）を必ずリストしてください。結果データがない場合もあなたの知識から記入してください。
- totalRacesはその馬の通算出走数、totalPlacesは通算2着以内の回数です。不明な場合はG1実績から推定してください。
- totalRaces: 0の馬は含めないでください
- updatedRulesは500文字以内で簡潔に記述してください
- summaryは1〜2文で簡潔に`

  return withRetry(async () => {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `あなたはJRA競馬の機械学習システムです。過去のレース結果を客観的に分析し、連対率予測の精度を向上させる知見を抽出します。horseStatsは必ず各レースの上位5頭以上を含めてください。必ずJSON形式のみで返答してください。`,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = message.content[0]
    if (content.type !== 'text') throw new Error('予期しないレスポンス形式')

    const jsonText = extractJSON(content.text.trim())
    const result = JSON.parse(jsonText) as LearningResult
    if (!Array.isArray(result.horseStats)) result.horseStats = []
    if (!Array.isArray(result.newInsights)) result.newInsights = []
    if (!Array.isArray(result.keyPatterns)) result.keyPatterns = []
    if (!result.summary) result.summary = '分析完了'
    if (!result.updatedRules) result.updatedRules = params.currentRules
    if (typeof result.estimatedAccuracy !== 'number') result.estimatedAccuracy = 0
    return result
  })
}
