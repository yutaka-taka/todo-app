'use client'

import { useState, useEffect, useCallback } from 'react'
import { format, isSunday, nextSunday } from 'date-fns'
import { ja } from 'date-fns/locale'

// ---- Types ----
interface RaceEntry {
  horseNumber: number
  horseName: string
  jockey?: string | null
  age?: number | null
  sex?: string | null
}

interface Race {
  id: string
  name: string
  date: string
  venue: string
  grade: string
  surface: string
  distance: number
  entries: RaceEntry[]
}

interface PredictionFactor {
  recentForm?: string
  distanceSuitability?: string
  courseRecord?: string
  jockeyStats?: string
  reason?: string
}

interface Prediction {
  rank: number
  horseNumber: number | null
  horseName: string
  placeRate: number
  factors?: PredictionFactor
}

interface LearningStatus {
  version: number
  analyzedCount: number
  accuracy?: number | null
  totalRaces: number
  analyzedRaces: number
  unanalyzedRaces: number
  horseStatCount: number
  localModeThreshold: number
  localModeReady: boolean
}

interface LearningResult {
  analyzed: number
  totalAnalyzed: number
  remaining: number
  newVersion?: number
  estimatedAccuracy?: number
  summary: string
  keyPatterns?: string[]
  newInsightsCount?: number
  horsesSaved?: number
  horseStatCount?: number
  raceNames?: string[]
  message?: string
  localModeReady?: boolean
}

// ---- Rank badge colors ----
const rankColors = [
  'from-yellow-400 to-amber-500',
  'from-gray-300 to-gray-400',
  'from-amber-600 to-amber-700',
  'from-blue-500 to-blue-600',
  'from-purple-500 to-purple-600',
]

const rankLabels = ['1st', '2nd', '3rd', '4th', '5th']

// ---- Spinner component ----
function Spinner({ size = 5 }: { size?: number }) {
  return (
    <svg
      className={`spinner w-${size} h-${size} text-yellow-400`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

// ---- PlaceRateBar ----
function PlaceRateBar({ rate }: { rate: number }) {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setWidth(rate), 100)
    return () => clearTimeout(timer)
  }, [rate])

  const color =
    rate >= 65
      ? 'from-emerald-400 to-emerald-500'
      : rate >= 50
        ? 'from-yellow-400 to-amber-500'
        : rate >= 35
          ? 'from-orange-400 to-orange-500'
          : 'from-blue-400 to-blue-500'

  return (
    <div className="mt-2">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-slate-400">連対率</span>
        <span className="text-sm font-bold text-white">{rate.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r ${color} rounded-full place-bar`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  )
}

// ---- Main Page ----
export default function Home() {
  const [races, setRaces] = useState<Race[]>([])
  const [targetDate, setTargetDate] = useState<string>('')
  const [selectedRace, setSelectedRace] = useState<Race | null>(null)
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [analysis, setAnalysis] = useState<string>('')
  const [predictionMode, setPredictionMode] = useState<'ai' | 'local' | null>(null)
  const [expandedCard, setExpandedCard] = useState<number | null>(null)

  const [loadingRaces, setLoadingRaces] = useState(true)
  const [predicting, setPredicting] = useState(false)
  const [learning, setLearning] = useState(false)

  const [raceError, setRaceError] = useState<string | null>(null)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [learnError, setLearnError] = useState<string | null>(null)

  const [learningStatus, setLearningStatus] = useState<LearningStatus | null>(null)
  const [learningResult, setLearningResult] = useState<LearningResult | null>(null)
  const [showLearnPanel, setShowLearnPanel] = useState(false)

  const fetchRaces = useCallback(async () => {
    setLoadingRaces(true)
    setRaceError(null)
    try {
      const res = await fetch('/api/races')
      if (!res.ok) throw new Error('レース情報の取得に失敗しました')
      const data = await res.json()
      setRaces(data.races ?? [])
      setTargetDate(data.targetDate ?? '')
    } catch (e) {
      setRaceError(e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setLoadingRaces(false)
    }
  }, [])

  const fetchLearnStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/learn')
      if (res.ok) {
        const data = await res.json()
        setLearningStatus(data)
      }
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    fetchRaces()
    fetchLearnStatus()
  }, [fetchRaces, fetchLearnStatus])

  const handleSelectRace = (race: Race) => {
    setSelectedRace(race)
    setPredictions([])
    setAnalysis('')
    setPredictError(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handlePredict = async () => {
    if (!selectedRace) return
    setPredicting(true)
    setPredictError(null)
    setPredictions([])
    setAnalysis('')
    try {
      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId: selectedRace.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setPredictions(data.predictions ?? [])
      setAnalysis(data.analysis ?? '')
      setPredictionMode(data.mode ?? null)
    } catch (e) {
      setPredictError(e instanceof Error ? e.message : '予想の生成に失敗しました')
    } finally {
      setPredicting(false)
    }
  }

  const handleLearn = async () => {
    setLearning(true)
    setLearnError(null)
    setLearningResult(null)
    try {
      const res = await fetch('/api/learn', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setLearningResult(data)
      await fetchLearnStatus()
    } catch (e) {
      setLearnError(e instanceof Error ? e.message : '自己学習に失敗しました')
    } finally {
      setLearning(false)
    }
  }

  const targetDateFormatted = targetDate
    ? format(new Date(targetDate), 'M月d日(E)', { locale: ja })
    : ''

  const today = new Date()
  const isTodaySunday = isSunday(today)

  return (
    <div className="min-h-dvh bg-[#080c18] pb-24">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#080c18]/90 backdrop-blur-md border-b border-[#1e2d4a]">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="gold-shimmer">🏇 競馬G1予想</span>
            </h1>
            <p className="text-[10px] text-slate-500">Claude AI 連対率予測</p>
          </div>
          <button
            onClick={() => setShowLearnPanel(!showLearnPanel)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[#1e2d4a] text-slate-400 hover:border-yellow-400/50 hover:text-yellow-400 transition-all"
          >
            <span>🧠</span>
            <span>自己学習</span>
          </button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4">

        {/* 自己学習パネル */}
        {showLearnPanel && (
          <div className="fade-in mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                🧠 AIアルゴリズム自己学習
              </h2>
              {learningStatus && (
                <span className="text-xs text-slate-500">
                  v{learningStatus.version}
                </span>
              )}
            </div>

            {learningStatus && (
              <>
                {/* ローカルモード進捗バー */}
                <div className="mb-3">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] text-slate-500">
                      馬データ蓄積 ({learningStatus.horseStatCount ?? 0} / {learningStatus.localModeThreshold}頭)
                    </span>
                    {learningStatus.localModeReady ? (
                      <span className="text-[10px] font-bold text-emerald-400">✓ Claude不要モード</span>
                    ) : (
                      <span className="text-[10px] text-slate-500">
                        あと{Math.max(0, learningStatus.localModeThreshold - (learningStatus.horseStatCount ?? 0))}頭で自律予想
                      </span>
                    )}
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${learningStatus.localModeReady ? 'bg-gradient-to-r from-emerald-400 to-emerald-500' : 'bg-gradient-to-r from-purple-500 to-indigo-500'}`}
                      style={{ width: `${Math.min(100, ((learningStatus.horseStatCount ?? 0) / learningStatus.localModeThreshold) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-[#080c18] rounded-xl p-2 text-center">
                    <div className="text-lg font-bold text-yellow-400">{learningStatus.analyzedRaces}</div>
                    <div className="text-[10px] text-slate-500">分析済み</div>
                  </div>
                  <div className="bg-[#080c18] rounded-xl p-2 text-center">
                    <div className="text-lg font-bold text-orange-400">{learningStatus.unanalyzedRaces}</div>
                    <div className="text-[10px] text-slate-500">未分析</div>
                  </div>
                  <div className="bg-[#080c18] rounded-xl p-2 text-center">
                    <div className="text-lg font-bold text-emerald-400">
                      {learningStatus.accuracy ? `${learningStatus.accuracy.toFixed(0)}%` : '-'}
                    </div>
                    <div className="text-[10px] text-slate-500">推定精度</div>
                  </div>
                </div>
              </>
            )}

            <button
              onClick={handleLearn}
              disabled={learning}
              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white"
            >
              {learning ? (
                <>
                  <Spinner size={4} />
                  <span className="pulse-gold">分析中... (30-60秒)</span>
                </>
              ) : (
                <>
                  <span>🔬</span>
                  <span>
                    {learningStatus && learningStatus.unanalyzedRaces > 0
                      ? `未分析${learningStatus.unanalyzedRaces}件を学習`
                      : '自己学習を実行'}
                  </span>
                </>
              )}
            </button>

            {learnError && (
              <div className="mt-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {learnError}
              </div>
            )}

            {learningResult && (
              <div className="mt-3 fade-in">
                {learningResult.analyzed === 0 ? (
                  <p className="text-xs text-slate-400 text-center">{learningResult.message}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-emerald-400 text-sm">✓</span>
                      <p className="text-xs text-emerald-400 font-medium">
                        {learningResult.raceNames?.join('、')} を分析しました
                        {learningResult.horsesSaved ? `（馬データ+${learningResult.horsesSaved}頭）` : ''}
                      </p>
                    </div>
                    {learningResult.localModeReady && (
                      <div className="mb-2 px-3 py-1.5 bg-emerald-900/30 border border-emerald-700/50 rounded-xl text-xs text-emerald-400 text-center font-bold">
                        🎉 Claude不要モード解放！予想はAPIなしで動作します
                      </div>
                    )}
                    <div className="bg-[#080c18] rounded-xl p-3">
                      <p className="text-xs text-slate-300 leading-relaxed">{learningResult.summary}</p>
                      {learningResult.keyPatterns && learningResult.keyPatterns.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {learningResult.keyPatterns.slice(0, 3).map((pattern, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                              <span className="text-yellow-400 text-[10px] mt-0.5">◆</span>
                              <p className="text-[11px] text-slate-400">{pattern}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {learningResult.remaining > 0 && (
                      <p className="text-xs text-slate-500 mt-2 text-center">
                        残り {learningResult.remaining} 件 — もう一度押すと続きを学習
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* 日付ヘッダー */}
        <div className="mb-4">
          <p className="text-xs text-slate-500 mb-0.5">
            {isTodaySunday ? '本日' : '次の日曜日'}のG1レース
          </p>
          <h2 className="text-xl font-bold text-white">
            {targetDateFormatted || '読み込み中...'}
          </h2>
        </div>

        {/* レース一覧 */}
        {loadingRaces ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size={8} />
          </div>
        ) : raceError ? (
          <div className="bg-red-900/20 border border-red-800/50 rounded-2xl p-4 text-center">
            <p className="text-red-400 text-sm">{raceError}</p>
            <button
              onClick={fetchRaces}
              className="mt-2 text-xs text-red-400 underline"
            >
              再試行
            </button>
          </div>
        ) : races.length === 0 ? (
          <div className="bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-6 text-center">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-slate-400 text-sm">
              この日曜日のG1レースは登録されていません。
            </p>
            <p className="text-slate-500 text-xs mt-2">
              DBシードを実行するか、管理者にお問い合わせください。
            </p>
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {races.map((race) => (
              <button
                key={race.id}
                onClick={() => handleSelectRace(race)}
                className={`race-card w-full text-left bg-[#0f1729] border rounded-2xl p-4 ${
                  selectedRace?.id === race.id
                    ? 'selected border-yellow-400'
                    : 'border-[#1e2d4a] hover:border-[#2e4a6a]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2 py-0.5 bg-yellow-400 text-black text-[10px] font-black rounded-full">
                        {race.grade}
                      </span>
                      <span className="text-[11px] text-slate-500">{race.venue}</span>
                    </div>
                    <h3 className="text-base font-bold text-white truncate">{race.name}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {race.surface} {race.distance}m
                      {race.entries.length > 0 && ` · ${race.entries.length}頭出走`}
                    </p>
                  </div>
                  {selectedRace?.id === race.id && (
                    <span className="text-yellow-400 text-lg">✓</span>
                  )}
                </div>

                {/* 出走馬サマリー */}
                {race.entries.length > 0 && selectedRace?.id === race.id && (
                  <div className="mt-3 pt-3 border-t border-[#1e2d4a]">
                    <p className="text-[10px] text-slate-500 mb-1.5">出走馬</p>
                    <div className="flex flex-wrap gap-1">
                      {race.entries.slice(0, 8).map((entry) => (
                        <span
                          key={entry.horseNumber}
                          className="text-[10px] bg-[#080c18] text-slate-300 px-2 py-0.5 rounded-full border border-[#1e2d4a]"
                        >
                          {entry.horseNumber}.{entry.horseName}
                        </span>
                      ))}
                      {race.entries.length > 8 && (
                        <span className="text-[10px] text-slate-500 px-2 py-0.5">
                          +{race.entries.length - 8}頭
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 予想ボタン */}
        {selectedRace && (
          <div className="sticky bottom-safe mb-4">
            <button
              onClick={handlePredict}
              disabled={predicting}
              className="w-full py-4 rounded-2xl font-black text-base tracking-wide transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed shadow-xl bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-300 hover:to-amber-400 text-black active:scale-95"
              style={{ boxShadow: '0 4px 24px rgba(245, 197, 24, 0.35)' }}
            >
              {predicting ? (
                <>
                  <Spinner size={5} />
                  <span>AIが予測中... (30-60秒)</span>
                </>
              ) : (
                <>
                  <span>🔮</span>
                  <span>{selectedRace.name} を予想する</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* 予測エラー */}
        {predictError && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-800/50 rounded-2xl">
            <p className="text-red-400 text-sm">{predictError}</p>
            {predictError.includes('ANTHROPIC_API_KEY') && (
              <p className="text-red-500 text-xs mt-1">
                Vercelの環境変数にANTHROPIC_API_KEYを設定してください
              </p>
            )}
          </div>
        )}

        {/* 予測結果 */}
        {predictions.length > 0 && (
          <div className="fade-in">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-base font-bold text-white">予想結果</h2>
              <span className="text-xs text-slate-500">— 連対率上位5頭</span>
              {predictionMode === 'local' && (
                <span className="ml-auto text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-900/50 text-emerald-400 border border-emerald-700/50">
                  🤖 API不要
                </span>
              )}
              {predictionMode === 'ai' && (
                <span className="ml-auto text-[9px] font-bold px-2 py-0.5 rounded-full bg-purple-900/50 text-purple-400 border border-purple-700/50">
                  ✨ Claude AI
                </span>
              )}
            </div>

            {/* レース分析 */}
            {analysis && (
              <div className="mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-yellow-400">🔍</span>
                  <p className="text-xs font-bold text-yellow-400">レース展望</p>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{analysis}</p>
              </div>
            )}

            {/* 予測カード */}
            <div className="space-y-3">
              {predictions.map((pred, i) => (
                <div
                  key={i}
                  className="fade-in bg-[#0f1729] border border-[#1e2d4a] rounded-2xl overflow-hidden"
                  style={{ animationDelay: `${i * 0.1}s` }}
                >
                  <button
                    className="w-full text-left p-4"
                    onClick={() => setExpandedCard(expandedCard === i ? null : i)}
                  >
                    <div className="flex items-center gap-3">
                      {/* ランクバッジ */}
                      <div
                        className={`w-10 h-10 rounded-xl bg-gradient-to-br ${rankColors[i]} flex items-center justify-center flex-shrink-0`}
                      >
                        <span className="text-black font-black text-sm">{rankLabels[i]}</span>
                      </div>

                      {/* 馬情報 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {pred.horseNumber && (
                            <span className="text-xs text-slate-500 font-mono">
                              {pred.horseNumber}番
                            </span>
                          )}
                          <span className="text-base font-bold text-white truncate">
                            {pred.horseName}
                          </span>
                        </div>
                        <PlaceRateBar rate={pred.placeRate} />
                      </div>

                      {/* 展開アイコン */}
                      <span className="text-slate-600 text-xs flex-shrink-0">
                        {expandedCard === i ? '▲' : '▼'}
                      </span>
                    </div>
                  </button>

                  {/* 展開コンテンツ（予想根拠） */}
                  {expandedCard === i && pred.factors && (
                    <div className="px-4 pb-4 border-t border-[#1e2d4a] pt-3">
                      <div className="space-y-2">
                        {pred.factors.reason && (
                          <div>
                            <p className="text-[10px] text-yellow-400 font-bold mb-1">総合評価</p>
                            <p className="text-xs text-slate-300 leading-relaxed">{pred.factors.reason}</p>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          {pred.factors.recentForm && (
                            <div className="bg-[#080c18] rounded-xl p-2">
                              <p className="text-[9px] text-slate-500 mb-0.5">最近の成績</p>
                              <p className="text-[11px] text-slate-300">{pred.factors.recentForm}</p>
                            </div>
                          )}
                          {pred.factors.distanceSuitability && (
                            <div className="bg-[#080c18] rounded-xl p-2">
                              <p className="text-[9px] text-slate-500 mb-0.5">距離適性</p>
                              <p className="text-[11px] text-slate-300">{pred.factors.distanceSuitability}</p>
                            </div>
                          )}
                          {pred.factors.courseRecord && (
                            <div className="bg-[#080c18] rounded-xl p-2">
                              <p className="text-[9px] text-slate-500 mb-0.5">コース実績</p>
                              <p className="text-[11px] text-slate-300">{pred.factors.courseRecord}</p>
                            </div>
                          )}
                          {pred.factors.jockeyStats && (
                            <div className="bg-[#080c18] rounded-xl p-2">
                              <p className="text-[9px] text-slate-500 mb-0.5">騎手評価</p>
                              <p className="text-[11px] text-slate-300">{pred.factors.jockeyStats}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 免責事項 */}
            <p className="text-center text-[10px] text-slate-600 mt-6">
              ※ 本予想はAIによる分析であり、馬券の的中を保証するものではありません。
              馬券は自己責任でお楽しみください。
            </p>
          </div>
        )}

        {/* 初期状態 */}
        {!loadingRaces && races.length > 0 && !selectedRace && predictions.length === 0 && (
          <div className="text-center py-8">
            <p className="text-4xl mb-3">☝️</p>
            <p className="text-slate-400 text-sm">上からレースを選んで「予想する」を押してください</p>
          </div>
        )}
      </main>

      {/* Bottom safe area for iOS */}
      <div className="h-8" />
    </div>
  )
}
