import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export interface PredictionEntry {
  horseNumber: number
  horseName: string
  jockey?: string | null
  age?: number | null
  sex?: string | null
  weight?: number | null
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
  const { raceName, raceDate, venue, surface, distance, grade, entries, algorithmRules } = params

  const entriesSection =
    entries.length > 0
      ? `【確定出走馬一覧】\n${entries
          .map(
            (e) =>
              `${e.horseNumber}番 ${e.horseName}${e.jockey ? ` 騎手:${e.jockey}` : ''}${e.age ? ` ${e.age}歳` : ''}${e.sex || ''}`
          )
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

【分析観点】
1. 過去の重賞実績（G1での連対経験を特に重視）
2. 距離適性（${distance}mでの実績）
3. ${venue}競馬場での実績
4. 直近の調子・成績推移
5. 騎手の重賞勝利率とこのコースでの相性
6. 血統的な適性（芝・ダート、距離適性）
7. 前走からの間隔と仕上がり
8. 斤量変化の影響

連対率が高い順に上位5頭を以下のJSON形式のみで返してください。JSON以外のテキストは一切含めないでください：

{
  "predictions": [
    {
      "rank": 1,
      "horseNumber": 7,
      "horseName": "馬名",
      "placeRate": 68.5,
      "factors": {
        "recentForm": "直近成績の評価（例：直近5走で4回連対、G1でも2着経験あり）",
        "distanceSuitability": "距離適性の評価",
        "courseRecord": "コース実績の評価",
        "jockeyStats": "騎手の評価",
        "reason": "総合的な予想根拠（2-3文）"
      }
    }
  ],
  "analysis": "レース全体の展望と見どころ（3-4文）"
}

重要：
- placeRateは30〜80の範囲で設定
- 出走馬が未確定の場合は、過去の出走傾向からの有力候補を名前付きで予測
- 必ずJSON形式のみで返答`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: `あなたはJRA競馬の専門アナリストです。過去のレースデータ、血統、騎手成績、調教内容を総合的に分析し、各馬の連対率を精密に算出します。必ずJSON形式のみで返答してください。`,
    messages: [{ role: 'user', content: prompt }],
  })

  const content = message.content[0]
  if (content.type !== 'text') throw new Error('予期しないレスポンス形式')

  const text = content.text.trim()
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = jsonMatch ? jsonMatch[1].trim() : text

  return JSON.parse(jsonText) as PredictionResponse
}

// ---- 自己学習用 ----

export interface LearnedInsight {
  category: string
  insight: string
  confidence: number
  applicableCases: string
}

export interface HorseStatData {
  horseName: string
  totalRaces: number
  totalPlaces: number
  g1Races: number
  g1Places: number
  distanceData: Record<string, { races: number; places: number }>
  venueData: Record<string, { races: number; places: number }>
  surfaceData: Record<string, { races: number; places: number }>
  recentForm: string
  lastRaceDate?: string
}

export interface LearningResult {
  horseStats: HorseStatData[]
  newInsights: LearnedInsight[]
  updatedRules: string
  keyPatterns: string[]
  estimatedAccuracy: number
  summary: string
}

export async function analyzeRacesForLearning(params: {
  racesData: string
  currentRules: string
}): Promise<LearningResult> {
  const { racesData, currentRules } = params

  const prompt = `以下の過去重賞レースを詳細に分析し、連対率予測アルゴリズムを改善してください。

【分析対象レース】
${racesData}

【現在の予想ルール】
${currentRules}

【分析タスク A: アルゴリズム改善】
1. 各レースの1着・2着馬の共通点・パターンを特定
2. 人気馬が馬券外に飛んだ要因を分析
3. 穴馬・低人気馬が好走した理由を抽出
4. 距離・コース・季節・馬場状態による傾向
5. 騎手・調教師コンビの影響度
6. 血統的傾向

【分析タスク B: 馬別成績データ抽出】
分析対象レースに登場した各馬について、あなたの知識から以下を推定してください：
- 通算出走数・連対数（概算でよい）
- G1での出走数・連対数
- 得意距離・競馬場・馬場（芝/ダート）
- 直近5走の着順（1-2-3-4-5着で表記、例: "1-2-3-1-2"）

以下のJSON形式のみで返してください。JSON以外のテキストは一切含めないでください：

{
  "horseStats": [
    {
      "horseName": "馬名",
      "totalRaces": 20,
      "totalPlaces": 12,
      "g1Races": 5,
      "g1Places": 3,
      "distanceData": {"3200": {"races": 4, "places": 3}, "3000": {"races": 2, "places": 1}},
      "venueData": {"京都": {"races": 5, "places": 3}, "阪神": {"races": 4, "places": 2}},
      "surfaceData": {"芝": {"races": 20, "places": 12}},
      "recentForm": "1-1-2-3-1",
      "lastRaceDate": "2024-04"
    }
  ],
  "newInsights": [
    {
      "category": "カテゴリ（例：距離適性, 騎手評価, 血統等）",
      "insight": "具体的な学習知見",
      "confidence": 0.85,
      "applicableCases": "この知見が適用できる条件"
    }
  ],
  "updatedRules": "改善された予想ルール全文",
  "keyPatterns": ["重要パターン1", "重要パターン2", "重要パターン3"],
  "estimatedAccuracy": 65.5,
  "summary": "今回の学習で得られた主要な知見（3-4文）"
}

重要: horseStatsには分析レースに登場した主な馬を含めてください。わからない場合は0で埋めてください。`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: `あなたはJRA競馬の機械学習システムです。過去のレース結果を客観的に分析し、連対率予測の精度を向上させる知見と馬別データを抽出します。必ずJSON形式のみで返答してください。`,
    messages: [{ role: 'user', content: prompt }],
  })

  const content = message.content[0]
  if (content.type !== 'text') throw new Error('予期しないレスポンス形式')

  const text = content.text.trim()
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = jsonMatch ? jsonMatch[1].trim() : text

  const result = JSON.parse(jsonText) as LearningResult
  // horseStats が未定義の場合は空配列
  if (!result.horseStats) result.horseStats = []
  return result
}
