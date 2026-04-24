'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { format, isSunday } from 'date-fns'
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
  upcomingRaceVerified?: boolean
  upcomingRaceName?: string
  upcomingHorsesSaved?: number
}

interface VerifyResult {
  verified: number
  raceName: string
  raceDate: string
  verifiedHorses?: string[]
  totalEntries?: number
  message: string
}

interface ReanalyzeResult {
  horsesSaved: number
  horseStatCount: number
  totalRaces: number
  analyzedRaces: number
  refinedAccuracy: number
  summary: string
  localModeReady: boolean
}

interface HorseStatRow {
  horseName: string
  totalRaces: number
  totalPlaces: number
  g1Races: number
  g1Places: number
  lastRaceDate: string | null
}

interface PredictedRaceForInput {
  id: string
  name: string
  date: string
  predictions: Array<{ rank: number; horseName: string; horseNumber: number | null; placeRate: number }>
}

interface ResultAccuracyStats {
  total: number
  accuracy: number
  completeHits: number
  halfHits: number
  misses: number
}

interface ResultFeedback {
  accuracy: number
  missInfo: string
  patternAnalysis: string
  algorithmChange: string
  overallStats: ResultAccuracyStats
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

// ---- Spinner ----
function Spinner({ size = 5 }: { size?: number }) {
  const px = size * 4
  return (
    <svg className="spinner text-yellow-400" style={{ width: px, height: px }} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
}

// ---- PlaceRateBar ----
function PlaceRateBar({ rate }: { rate: number }) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setWidth(rate), 100)
    return () => clearTimeout(t)
  }, [rate])
  const color =
    rate >= 65 ? 'from-emerald-400 to-emerald-500'
    : rate >= 50 ? 'from-yellow-400 to-amber-500'
    : rate >= 35 ? 'from-orange-400 to-orange-500'
    : 'from-blue-400 to-blue-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-slate-400">連対率</span>
        <span className="text-sm font-bold text-white">{rate.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full bg-gradient-to-r ${color} rounded-full place-bar`} style={{ width: `${width}%` }} />
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
  const [learningAll, setLearningAll] = useState(false)
  const [learnAllProgress, setLearnAllProgress] = useState<{ processed: number; total: number } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<{ resetCount: number; message: string } | null>(null)
  const [resetConfirmStep, setResetConfirmStep] = useState<0 | 1 | 2>(0)
  const [reanalyzeConfirm, setReanalyzeConfirm] = useState(false)

  const [raceError, setRaceError] = useState<string | null>(null)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [learnError, setLearnError] = useState<string | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null)

  const [learningStatus, setLearningStatus] = useState<LearningStatus | null>(null)
  const [learningResult, setLearningResult] = useState<LearningResult | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)
  const [reanalyzeResult, setReanalyzeResult] = useState<ReanalyzeResult | null>(null)
  const [showLearnPanel, setShowLearnPanel] = useState(false)

  // 馬体重入力
  const [showWeightForm, setShowWeightForm] = useState(false)
  const [horseWeightInputs, setHorseWeightInputs] = useState<Record<string, { weight: string; weightChange: string }>>({})

  // 天気・馬場状態
  const [weatherData, setWeatherData] = useState<{ weather: string; temperature: number; precipMm: number; conditionEstimate: string; icon: string } | null>(null)
  const [trackCondition, setTrackCondition] = useState<string>('良')
  const [fetchingWeather, setFetchingWeather] = useState(false)

  // 予想照合
  const [racesForResult, setRacesForResult] = useState<PredictedRaceForInput[]>([])
  const [loadingRacesForResult, setLoadingRacesForResult] = useState(false)
  const [resultInputs, setResultInputs] = useState<Record<string, { first: string; second: string }>>({})
  const [submittingResult, setSubmittingResult] = useState<string | null>(null)
  const [resultFeedback, setResultFeedback] = useState<Record<string, ResultFeedback>>({})
  const [resultError, setResultError] = useState<Record<string, string>>({})
  const [resultStats, setResultStats] = useState<ResultAccuracyStats | null>(null)
  const [fetchingResult, setFetchingResult] = useState<Record<string, boolean>>({})

  // DB最適化
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeResult, setOptimizeResult] = useState<{
    elapsed: number; dbSize: string; totalDeadTuples: number;
    tables: { name: string; size: string; liveTuples: number; deadTuples: number }[]
  } | null>(null)
  const [optimizeError, setOptimizeError] = useState<string | null>(null)
  const [dbStats, setDbStats] = useState<{
    dbSize: string; totalDeadTuples: number; lastVacuum: string;
    tables: { name: string; size: string; liveTuples: number; deadTuples: number }[]
  } | null>(null)

  // 馬データ管理
  const [showHorsesPanel, setShowHorsesPanel] = useState(false)
  const [horses, setHorses] = useState<HorseStatRow[]>([])
  const [horsesTotal, setHorsesTotal] = useState(0)
  const [horsesHasMore, setHorsesHasMore] = useState(false)
  const [horsePage, setHorsePage] = useState(1)
  const [horseSearch, setHorseSearch] = useState('')
  const [horseLoading, setHorseLoading] = useState(false)
  const [horseError, setHorseError] = useState<string | null>(null)
  const [deletingHorse, setDeletingHorse] = useState<string | null>(null)
  const [deleteAllConfirmStep, setDeleteAllConfirmStep] = useState<0 | 1 | 2>(0)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    } catch { /* silent */ }
  }, [])

  const fetchDbStats = useCallback(async () => {
    try {
      const res = await fetch('/api/optimize')
      if (res.ok) setDbStats(await res.json())
    } catch { /* silent */ }
  }, [])

  const handleOptimize = async () => {
    setOptimizing(true)
    setOptimizeError(null)
    setOptimizeResult(null)
    try {
      const res = await fetch('/api/optimize', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '最適化に失敗しました')
      setOptimizeResult(data)
      await fetchDbStats()
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : '最適化に失敗しました')
    } finally {
      setOptimizing(false)
    }
  }

  const fetchHorses = useCallback(async (search: string, page: number, append = false) => {
    setHorseLoading(true)
    setHorseError(null)
    try {
      const params = new URLSearchParams({ page: String(page) })
      if (search) params.set('search', search)
      const res = await fetch(`/api/horses?${params}`)
      if (!res.ok) throw new Error('取得失敗')
      const data = await res.json()
      setHorses((prev) => append ? [...prev, ...data.horses] : data.horses)
      setHorsesTotal(data.total)
      setHorsesHasMore(data.hasMore)
      setHorsePage(page)
    } catch (e) {
      setHorseError(e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setHorseLoading(false)
    }
  }, [])

  const fetchRacesForResult = useCallback(async () => {
    setLoadingRacesForResult(true)
    try {
      const res = await fetch('/api/results')
      if (res.ok) {
        const data = await res.json()
        setRacesForResult(data.races ?? [])
        if (data.stats) setResultStats(data.stats)
      }
    } catch { /* silent */ } finally {
      setLoadingRacesForResult(false)
    }
  }, [])

  const handleFetchResult = async (raceId: string) => {
    setFetchingResult((prev) => ({ ...prev, [raceId]: true }))
    setResultError((prev) => { const n = { ...prev }; delete n[raceId]; return n })
    try {
      const res = await fetch('/api/fetch-race-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResultInputs((prev) => ({
        ...prev,
        [raceId]: { first: data.first ?? '', second: data.second ?? '' },
      }))
    } catch (e) {
      setResultError((prev) => ({
        ...prev,
        [raceId]: e instanceof Error ? e.message : 'ネットからの取得に失敗しました',
      }))
    } finally {
      setFetchingResult((prev) => ({ ...prev, [raceId]: false }))
    }
  }

  const handleSubmitResult = async (raceId: string, first: string, second: string) => {
    setSubmittingResult(raceId)
    setResultError((prev) => { const n = { ...prev }; delete n[raceId]; return n })
    try {
      const res = await fetch('/api/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId, first, second }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResultFeedback((prev) => ({
        ...prev,
        [raceId]: {
          accuracy: data.accuracy,
          missInfo: data.missInfo,
          patternAnalysis: data.patternAnalysis,
          algorithmChange: data.algorithmChange,
          overallStats: data.overallStats,
        },
      }))
      if (data.overallStats) setResultStats(data.overallStats)
      await fetchLearnStatus()
    } catch (e) {
      setResultError((prev) => ({
        ...prev,
        [raceId]: e instanceof Error ? e.message : '送信に失敗しました',
      }))
    } finally {
      setSubmittingResult(null)
    }
  }

  useEffect(() => {
    fetchRaces()
    fetchLearnStatus()
    fetchDbStats()
  }, [fetchRaces, fetchLearnStatus, fetchDbStats])

  useEffect(() => {
    if (showHorsesPanel) fetchHorses('', 1)
  }, [showHorsesPanel, fetchHorses])

  useEffect(() => {
    if (showLearnPanel) fetchRacesForResult()
  }, [showLearnPanel, fetchRacesForResult])

  const handleHorseSearchChange = (value: string) => {
    setHorseSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      fetchHorses(value, 1)
    }, 350)
  }

  const handleDeleteHorse = async (horseName: string) => {
    setDeletingHorse(horseName)
    setHorseError(null)
    try {
      const res = await fetch('/api/horses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ horseName }),
      })
      if (!res.ok) throw new Error('削除失敗')
      setHorses((prev) => prev.filter((h) => h.horseName !== horseName))
      setHorsesTotal((prev) => prev - 1)
      await fetchLearnStatus()
    } catch (e) {
      setHorseError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setDeletingHorse(null)
    }
  }

  const handleDeleteAll = async () => {
    setHorseLoading(true)
    setHorseError(null)
    try {
      const res = await fetch('/api/horses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteAll: true }),
      })
      if (!res.ok) throw new Error('削除失敗')
      setHorses([])
      setHorsesTotal(0)
      setHorsesHasMore(false)
      setDeleteAllConfirmStep(0)
      await fetchLearnStatus()
    } catch (e) {
      setHorseError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setHorseLoading(false)
    }
  }

  const handleSelectRace = (race: Race) => {
    setSelectedRace(race)
    setPredictions([])
    setAnalysis('')
    setPredictError(null)
    setHorseWeightInputs({})
    setShowWeightForm(false)
    setWeatherData(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  useEffect(() => {
    if (!selectedRace) return
    const venue = selectedRace.venue
    const date = selectedRace.date.slice(0, 10)
    setFetchingWeather(true)
    fetch(`/api/weather?venue=${encodeURIComponent(venue)}&date=${date}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) {
          setWeatherData(data)
          setTrackCondition(data.conditionEstimate ?? '良')
        }
      })
      .catch(() => {})
      .finally(() => setFetchingWeather(false))
  }, [selectedRace?.id])

  const handlePredict = async () => {
    if (!selectedRace) return
    setPredicting(true)
    setPredictError(null)
    setPredictions([])
    setAnalysis('')
    try {
      // 馬体重入力データを整形
      const horseWeights: Record<string, { weight: number | null; weightChange: number | null }> = {}
      for (const [name, inputs] of Object.entries(horseWeightInputs)) {
        const w = inputs.weight !== '' ? Number(inputs.weight) : null
        const wcRaw = inputs.weightChange.replace('+', '')
        const wc = wcRaw !== '' ? parseInt(wcRaw) : null
        if (w !== null || (wc !== null && !isNaN(wc))) {
          horseWeights[name] = { weight: w, weightChange: wc !== null && !isNaN(wc) ? wc : null }
        }
      }

      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId: selectedRace.id, horseWeights, trackCondition }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setPredictions(data.predictions ?? [])
      setAnalysis(data.analysis ?? '')
      setPredictionMode(data.mode ?? null)
      fetchRacesForResult()
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

  const handleLearnAll = async () => {
    setLearningAll(true)
    setLearnError(null)
    setLearningResult(null)
    try {
      const statusRes = await fetch('/api/learn')
      const status = await statusRes.json()
      const total: number = status.unanalyzedRaces ?? 0
      if (total === 0) {
        setLearnAllProgress({ processed: 0, total: 0 })
        setLearningAll(false)
        return
      }
      setLearnAllProgress({ processed: 0, total })
      let remaining = total
      let lastResult = null
      while (remaining > 0) {
        const res = await fetch('/api/learn', { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        lastResult = data
        remaining = data.remaining ?? 0
        setLearnAllProgress({ processed: total - remaining, total })
      }
      if (lastResult) setLearningResult(lastResult)
      await fetchLearnStatus()
    } catch (e) {
      setLearnError(e instanceof Error ? e.message : '一括学習に失敗しました')
    } finally {
      setLearningAll(false)
    }
  }

  const handleResetLearning = async () => {
    setResetting(true)
    setResetResult(null)
    try {
      const res = await fetch('/api/reanalyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResetResult(data)
      await fetchLearnStatus()
    } catch (e) {
      setLearnError(e instanceof Error ? e.message : 'リセットに失敗しました')
    } finally {
      setResetting(false)
    }
  }

  const handleReanalyze = async () => {
    setReanalyzing(true)
    setReanalyzeError(null)
    setReanalyzeResult(null)
    try {
      const res = await fetch('/api/reanalyze', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setReanalyzeResult(data)
      await fetchLearnStatus()
    } catch (e) {
      setReanalyzeError(e instanceof Error ? e.message : '全レース再検証に失敗しました')
    } finally {
      setReanalyzing(false)
    }
  }

  const handleVerify = async () => {
    setVerifying(true)
    setVerifyError(null)
    setVerifyResult(null)
    try {
      const res = await fetch('/api/verify', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setVerifyResult(data)
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : '再検証に失敗しました')
    } finally {
      setVerifying(false)
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
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold tracking-tight">
              <span className="gold-shimmer">🏇 競馬G1予想</span>
            </h1>
            <p className="text-[10px] text-slate-500">Claude AI 連対率予測</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowHorsesPanel(!showHorsesPanel); setShowLearnPanel(false) }}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
                showHorsesPanel
                  ? 'border-blue-400/70 text-blue-400 bg-blue-900/20'
                  : 'border-[#1e2d4a] text-slate-400 hover:border-blue-400/50 hover:text-blue-400'
              }`}
            >
              <span>🐴</span>
              <span>馬一覧</span>
            </button>
            <button
              onClick={() => { setShowLearnPanel(!showLearnPanel); setShowHorsesPanel(false) }}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
                showLearnPanel
                  ? 'border-purple-400/70 text-purple-400 bg-purple-900/20'
                  : 'border-[#1e2d4a] text-slate-400 hover:border-yellow-400/50 hover:text-yellow-400'
              }`}
            >
              <span>🧠</span>
              <span>自己学習</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4">

        {/* ===== 馬データ管理パネル ===== */}
        {showHorsesPanel && (
          <div className="fade-in mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                🐴 馬データ管理
              </h2>
              <span className="text-xs text-slate-500">{horsesTotal}頭</span>
            </div>

            {/* DB使用量の目安 */}
            <div className="mb-3 p-2.5 bg-[#080c18] rounded-xl">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-slate-500">蓄積データ量（概算）</span>
                <span className="text-[10px] text-slate-400">
                  約{horsesTotal < 1000 ? `${Math.round(horsesTotal * 0.5)}KB` : `${(horsesTotal * 0.5 / 1024).toFixed(1)}MB`}（ローカルDB・容量無制限）
                </span>
              </div>
            </div>

            {/* 検索 */}
            <div className="relative mb-3">
              <input
                type="text"
                value={horseSearch}
                onChange={(e) => handleHorseSearchChange(e.target.value)}
                placeholder="馬名で検索..."
                className="w-full bg-[#080c18] border border-[#1e2d4a] rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-400/50"
              />
              {horseSearch && (
                <button
                  onClick={() => handleHorseSearchChange('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* 全件削除ボタン */}
            {horsesTotal > 0 && (
              <div className="mb-3">
                <button
                  onClick={() => setDeleteAllConfirmStep(1)}
                  className="w-full py-2 rounded-xl text-xs border border-red-800/50 text-red-400 hover:bg-red-900/20 transition-all"
                >
                  🗑 全件削除（DB容量を解放）
                </button>
              </div>
            )}

            {/* 全件削除 2段階確認モーダル */}
            {deleteAllConfirmStep >= 1 && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                <div className="bg-[#0d1829] border border-red-800/60 rounded-2xl p-6 w-72 shadow-2xl">
                  <p className="text-sm text-white font-bold mb-1 text-center">
                    {deleteAllConfirmStep === 1 ? '本当に実行していいですか？' : '最終確認：本当に削除しますか？'}
                  </p>
                  <p className="text-xs text-slate-400 text-center mb-5">
                    {deleteAllConfirmStep === 1
                      ? `全${horsesTotal}頭のデータが削除されます`
                      : 'この操作は元に戻せません'}
                  </p>
                  <div className="flex gap-3">
                    <button
                      autoFocus
                      onClick={() => setDeleteAllConfirmStep(0)}
                      className="flex-1 py-2 rounded-xl text-sm border border-[#1e2d4a] text-slate-300 hover:bg-[#1a2640] transition-all"
                    >
                      いいえ
                    </button>
                    <button
                      onClick={() => {
                        if (deleteAllConfirmStep === 1) {
                          setDeleteAllConfirmStep(2)
                        } else {
                          setDeleteAllConfirmStep(0)
                          handleDeleteAll()
                        }
                      }}
                      disabled={horseLoading}
                      className="flex-1 py-2 rounded-xl text-sm font-bold bg-red-700 hover:bg-red-600 text-white transition-all disabled:opacity-50"
                    >
                      はい
                    </button>
                  </div>
                </div>
              </div>
            )}

            {horseError && (
              <div className="mb-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {horseError}
              </div>
            )}

            {/* 馬一覧 */}
            {horseLoading && horses.length === 0 ? (
              <div className="flex justify-center py-6">
                <Spinner size={6} />
              </div>
            ) : horses.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">
                {horseSearch ? '該当する馬が見つかりません' : '馬データがありません。自己学習を実行してください。'}
              </p>
            ) : (
              <>
                {/* ヘッダー行 */}
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 px-2 mb-1">
                  <span className="text-[9px] text-slate-600">馬名</span>
                  <span className="text-[9px] text-slate-600 text-right">連対率</span>
                  <span className="text-[9px] text-slate-600 text-right">出走数</span>
                  <span className="text-[9px] text-slate-600 text-center">削除</span>
                </div>
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {horses.map((horse) => {
                    const placeRate = horse.totalRaces > 0
                      ? ((horse.totalPlaces / horse.totalRaces) * 100).toFixed(0)
                      : '-'
                    const isDeleting = deletingHorse === horse.horseName
                    return (
                      <div
                        key={horse.horseName}
                        className={`grid grid-cols-[1fr_auto_auto_auto] gap-x-2 items-center px-2 py-1.5 rounded-lg bg-[#080c18] border border-[#1a2640] transition-opacity ${isDeleting ? 'opacity-40' : ''}`}
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-white truncate">{horse.horseName}</p>
                          {horse.g1Races > 0 && (
                            <p className="text-[9px] text-yellow-500">G1: {horse.g1Races}戦{horse.g1Places}連対</p>
                          )}
                        </div>
                        <span className={`text-xs font-bold tabular-nums ${
                          Number(placeRate) >= 50 ? 'text-emerald-400'
                          : Number(placeRate) >= 30 ? 'text-yellow-400'
                          : 'text-slate-400'
                        }`}>
                          {placeRate !== '-' ? `${placeRate}%` : '-'}
                        </span>
                        <span className="text-xs text-slate-500 tabular-nums text-right">
                          {horse.totalRaces}
                        </span>
                        <button
                          onClick={() => handleDeleteHorse(horse.horseName)}
                          disabled={isDeleting || horseLoading}
                          className="w-6 h-6 flex items-center justify-center rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition-all disabled:opacity-30 text-xs"
                          title="削除"
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
                {horsesHasMore && (
                  <button
                    onClick={() => fetchHorses(horseSearch, horsePage + 1, true)}
                    disabled={horseLoading}
                    className="mt-2 w-full py-2 text-xs text-slate-400 border border-[#1e2d4a] rounded-xl hover:border-blue-400/40 transition-all disabled:opacity-50"
                  >
                    {horseLoading ? '読み込み中...' : `もっと見る（残 ${horsesTotal - horses.length}頭）`}
                  </button>
                )}
                <p className="text-[9px] text-slate-600 text-center mt-2">
                  {horsesTotal}頭中 {horses.length}頭を表示
                </p>
              </>
            )}
          </div>
        )}

        {/* ===== 自己学習パネル ===== */}
        {showLearnPanel && (
          <div className="fade-in mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                🧠 AIアルゴリズム自己学習
              </h2>
              {learningStatus && (
                <span className="text-xs text-slate-500">v{learningStatus.version}</span>
              )}
            </div>

            {learningStatus && (
              <>
                <div className="mb-3">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] text-slate-500">
                      馬データ蓄積 ({learningStatus.horseStatCount ?? 0}頭)
                    </span>
                    {learningStatus.localModeReady && (
                      <span className="text-[10px] font-bold text-emerald-400">✓ Claude不要モード</span>
                    )}
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${
                        learningStatus.localModeReady
                          ? 'bg-gradient-to-r from-emerald-400 to-emerald-500'
                          : 'bg-gradient-to-r from-purple-500 to-indigo-500'
                      }`}
                      style={{
                        width: `${Math.min(100, ((learningStatus.horseStatCount ?? 0) / learningStatus.localModeThreshold) * 100)}%`,
                      }}
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

            {/* ① 過去レース学習ボタン（3件ずつ） */}
            <div className="flex gap-2">
              <button
                onClick={handleLearn}
                disabled={learning || learningAll || verifying || reanalyzing}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white"
              >
                {learning ? (
                  <>
                    <Spinner size={4} />
                    <span className="pulse-gold">分析中...</span>
                  </>
                ) : (
                  <>
                    <span>🔬</span>
                    <span>3件学習</span>
                  </>
                )}
              </button>
              <button
                onClick={handleLearnAll}
                disabled={learning || learningAll || verifying || reanalyzing}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-purple-800 to-indigo-800 hover:from-purple-700 hover:to-indigo-700 text-white"
              >
                {learningAll ? (
                  <>
                    <Spinner size={4} />
                    <span className="pulse-gold">
                      {learnAllProgress
                        ? `${learnAllProgress.processed}/${learnAllProgress.total}件`
                        : '処理中...'}
                    </span>
                  </>
                ) : (
                  <>
                    <span>⚡</span>
                    <span>
                      {learningStatus && learningStatus.unanalyzedRaces > 0
                        ? `全${learningStatus.unanalyzedRaces}件一括`
                        : '全件一括学習'}
                    </span>
                  </>
                )}
              </button>
            </div>

            {learnError && (
              <div className="mt-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {learnError}
              </div>
            )}

            {learningResult && (
              <div className="mt-2 fade-in">
                {learningResult.analyzed === 0 ? (
                  <p className="text-xs text-slate-400 text-center">{learningResult.message}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-emerald-400 text-sm">✓</span>
                      <p className="text-xs text-emerald-400 font-medium">
                        {learningResult.raceNames?.join('、')} を分析
                        {learningResult.horsesSaved ? `（+${learningResult.horsesSaved}頭）` : ''}
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
                      <p className="text-xs text-slate-500 mt-1 text-center">
                        残り {learningResult.remaining} 件 — もう一度押すと続きを学習
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 区切り線 */}
            <div className="my-3 border-t border-[#1e2d4a]" />

            {/* ② 週末レース再検証ボタン */}
            <button
              onClick={handleVerify}
              disabled={learning || verifying}
              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white"
            >
              {verifying ? (
                <>
                  <Spinner size={4} />
                  <span className="pulse-gold">再検証中... (30-60秒)</span>
                </>
              ) : (
                <>
                  <span>↻</span>
                  <span>週末レース 出走馬を再検証</span>
                </>
              )}
            </button>

            {verifyError && (
              <div className="mt-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {verifyError}
              </div>
            )}

            {verifyResult && (
              <div className="mt-2 fade-in">
                {verifyResult.verified === 0 ? (
                  <p className="text-xs text-slate-400 text-center">{verifyResult.message}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-blue-400 text-sm">✓</span>
                      <p className="text-xs text-blue-400 font-medium">
                        {verifyResult.raceName}（{verifyResult.raceDate}） {verifyResult.verified}頭を最新化
                      </p>
                    </div>
                    {verifyResult.verifiedHorses && verifyResult.verifiedHorses.length > 0 && (
                      <div className="bg-[#080c18] rounded-xl p-3">
                        <p className="text-[10px] text-slate-500 mb-1">再検証済み出走馬</p>
                        <p className="text-[11px] text-slate-300 leading-relaxed">
                          {verifyResult.verifiedHorses.join('、')}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 区切り線 */}
            <div className="my-3 border-t border-[#1e2d4a]" />

            {/* ③ 全レース再検証ボタン */}
            <button
              onClick={() => setReanalyzeConfirm(true)}
              disabled={learning || learningAll || verifying || reanalyzing}
              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-amber-700 to-orange-700 hover:from-amber-600 hover:to-orange-600 text-white"
            >
              {reanalyzing ? (
                <>
                  <Spinner size={4} />
                  <span className="pulse-gold">全データ再構築・精緻化中... (60-120秒)</span>
                </>
              ) : (
                <>
                  <span>🔄</span>
                  <span>全レース再検証（精度向上）</span>
                </>
              )}
            </button>
            <p className="text-[10px] text-slate-600 text-center mt-1">
              全RaceResultからHorseStatを再構築し、AIが予想ルールを精緻化します
            </p>

            {/* 学習リセット */}
            <div className="my-3 border-t border-[#1e2d4a]" />
            <button
              onClick={() => setResetConfirmStep(1)}
              disabled={resetting || learning || learningAll || reanalyzing}
              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed border border-red-800/50 text-red-400 hover:bg-red-900/20"
            >
              {resetting ? (
                <><Spinner size={4} /><span>リセット中...</span></>
              ) : (
                <><span>⚠️</span><span>学習リセット</span></>
              )}
            </button>
            <p className="text-[10px] text-slate-600 text-center mt-1">
              全レースを「未分析」に戻し、「全件一括学習」で馬データを再構築します
            </p>

            {/* リセット確認ダイアログ */}
            {resetConfirmStep > 0 && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                <div className="bg-[#0d1525] border border-red-800/60 rounded-2xl p-6 w-80 shadow-2xl">
                  <p className="text-red-400 font-bold text-sm mb-1 text-center">
                    {resetConfirmStep === 1 ? '⚠️ 確認' : '⚠️ 再確認'}
                  </p>
                  <p className="text-white text-sm text-center leading-relaxed mb-5">
                    {resetConfirmStep === 1
                      ? '本当に実行していいですか？'
                      : 'もう一度確認します。\n本当に実行していいですか？'}
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        if (resetConfirmStep === 1) {
                          setResetConfirmStep(2)
                        } else {
                          setResetConfirmStep(0)
                          handleResetLearning()
                        }
                      }}
                      className="flex-1 py-2 rounded-xl text-sm font-bold border border-red-700/50 text-red-400 hover:bg-red-900/30 transition-all"
                    >
                      はい
                    </button>
                    <button
                      autoFocus
                      onClick={() => setResetConfirmStep(0)}
                      className="flex-1 py-2 rounded-xl text-sm font-bold bg-slate-700 hover:bg-slate-600 text-white transition-all focus:ring-2 focus:ring-slate-400 focus:outline-none"
                    >
                      いいえ
                    </button>
                  </div>
                </div>
              </div>
            )}
            {resetResult && (
              <div className="mt-2 fade-in p-3 bg-red-900/20 border border-red-800/30 rounded-xl">
                <p className="text-xs text-red-300 font-bold mb-1">✓ {resetResult.resetCount}件をリセット完了</p>
                <p className="text-[11px] text-slate-400 leading-relaxed">{resetResult.message}</p>
              </div>
            )}

            {reanalyzeError && (
              <div className="mt-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {reanalyzeError}
              </div>
            )}

            {/* 全レース再検証 確認ダイアログ */}
            {reanalyzeConfirm && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                <div className="bg-[#0d1525] border border-amber-700/60 rounded-2xl p-6 w-80 shadow-2xl">
                  <p className="text-amber-400 font-bold text-sm mb-1 text-center">🔄 確認</p>
                  <p className="text-white text-sm text-center leading-relaxed mb-5">
                    長時間かかりますが<br />実行してよいですか？
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => { setReanalyzeConfirm(false); handleReanalyze() }}
                      className="flex-1 py-2 rounded-xl text-sm font-bold border border-amber-700/50 text-amber-400 hover:bg-amber-900/30 transition-all"
                    >
                      はい
                    </button>
                    <button
                      autoFocus
                      onClick={() => setReanalyzeConfirm(false)}
                      className="flex-1 py-2 rounded-xl text-sm font-bold bg-slate-700 hover:bg-slate-600 text-white transition-all focus:ring-2 focus:ring-slate-400 focus:outline-none"
                    >
                      いいえ
                    </button>
                  </div>
                </div>
              </div>
            )}

            {reanalyzeResult && (
              <div className="mt-2 fade-in">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-amber-400 text-sm">✓</span>
                  <p className="text-xs text-amber-400 font-medium">
                    {reanalyzeResult.horsesSaved > 0
                      ? `${reanalyzeResult.horsesSaved}頭を再構築`
                      : '既存データを維持してルール精緻化'}
                    {reanalyzeResult.refinedAccuracy > 0
                      ? `（推定精度 ${reanalyzeResult.refinedAccuracy.toFixed(1)}%）`
                      : ''}
                  </p>
                </div>
                <div className="bg-[#080c18] rounded-xl p-3">
                  <p className="text-xs text-slate-300 leading-relaxed">{reanalyzeResult.summary}</p>
                </div>
                {reanalyzeResult.localModeReady && (
                  <div className="mt-2 px-3 py-1.5 bg-emerald-900/30 border border-emerald-700/50 rounded-xl text-xs text-emerald-400 text-center font-bold">
                    🎉 Claude不要モード継続！精度が向上しました
                  </div>
                )}
              </div>
            )}

            {/* 区切り線 */}
            <div className="my-3 border-t border-[#1e2d4a]" />

            {/* ⑤ DB最適化 */}
            {dbStats && (
              <div className="mb-2 px-3 py-2 bg-[#080c18] rounded-xl flex items-center justify-between">
                <div className="text-[10px] text-slate-500">
                  <span>DB容量: </span>
                  <span className="text-slate-300">{dbStats.dbSize}</span>
                  {dbStats.totalDeadTuples > 0 && (
                    <span className="ml-2 text-amber-500">不要データ: {dbStats.totalDeadTuples.toLocaleString()}件</span>
                  )}
                </div>
                <span className="text-[10px] text-slate-600">最終VACUUM: {dbStats.lastVacuum}</span>
              </div>
            )}
            <button
              onClick={handleOptimize}
              disabled={optimizing || learning || learningAll || reanalyzing}
              className="w-full py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-teal-700 to-cyan-700 hover:from-teal-600 hover:to-cyan-600 text-white"
            >
              {optimizing ? (
                <><Spinner size={4} /><span className="pulse-gold">VACUUM ANALYZE 実行中...</span></>
              ) : (
                <><span>🗄️</span><span>DB最適化</span></>
              )}
            </button>
            <p className="text-[10px] text-slate-600 text-center mt-1">
              VACUUM ANALYZEで不要データを削除し、クエリ性能を向上させます
            </p>

            {optimizeError && (
              <div className="mt-2 p-2 bg-red-900/30 border border-red-800/50 rounded-xl text-xs text-red-400">
                {optimizeError}
              </div>
            )}

            {optimizeResult && (
              <div className="mt-2 fade-in p-3 bg-teal-900/20 border border-teal-800/30 rounded-xl">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-teal-400 text-sm">✓</span>
                  <p className="text-xs text-teal-400 font-medium">
                    最適化完了（{(optimizeResult.elapsed / 1000).toFixed(1)}秒）
                  </p>
                </div>
                <div className="flex justify-between text-[10px] mb-2">
                  <span className="text-slate-500">DB容量</span>
                  <span className="text-slate-300">{optimizeResult.dbSize}</span>
                </div>
                <div className="flex justify-between text-[10px] mb-2">
                  <span className="text-slate-500">残不要データ</span>
                  <span className={optimizeResult.totalDeadTuples === 0 ? 'text-emerald-400' : 'text-amber-400'}>
                    {optimizeResult.totalDeadTuples === 0 ? 'なし' : `${optimizeResult.totalDeadTuples}件`}
                  </span>
                </div>
                <div className="space-y-1 mt-2 border-t border-teal-800/30 pt-2">
                  {optimizeResult.tables.slice(0, 5).map((t) => (
                    <div key={t.name} className="flex justify-between text-[10px]">
                      <span className="text-slate-500">{t.name}</span>
                      <span className="text-slate-400">{t.size} / {t.liveTuples.toLocaleString()}件</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 区切り線 */}
            <div className="my-3 border-t border-[#1e2d4a]" />

            {/* ④ 予想照合・自己改善 */}
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>📊</span><span>予想照合・自己改善</span>
              </h3>
              {racesForResult.length > 0 && (
                <span className="text-[10px] text-teal-400 font-bold">{racesForResult.length}件 入力待ち</span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
              「予想する」→レース終了→1着・2着を入力。AIが全累積ミスを統計分析してアルゴリズムを自動改善します
            </p>

            {/* 累積精度ダッシュボード */}
            {resultStats && resultStats.total > 0 && (
              <div className="mb-3 bg-[#080c18] rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-slate-500">通算予想精度（{resultStats.total}レース照合済み）</span>
                  <span className={`text-sm font-black ${
                    resultStats.accuracy >= 60 ? 'text-emerald-400'
                    : resultStats.accuracy >= 40 ? 'text-yellow-400'
                    : 'text-orange-400'
                  }`}>{resultStats.accuracy}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      resultStats.accuracy >= 60 ? 'bg-gradient-to-r from-emerald-400 to-emerald-500'
                      : resultStats.accuracy >= 40 ? 'bg-gradient-to-r from-yellow-400 to-amber-500'
                      : 'bg-gradient-to-r from-orange-400 to-orange-500'
                    }`}
                    style={{ width: `${Math.min(100, resultStats.accuracy)}%` }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-1 text-center">
                  <div>
                    <div className="text-sm font-bold text-emerald-400">{resultStats.completeHits}</div>
                    <div className="text-[9px] text-slate-600">完全的中</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-yellow-400">{resultStats.halfHits}</div>
                    <div className="text-[9px] text-slate-600">半的中</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-red-400">{resultStats.misses}</div>
                    <div className="text-[9px] text-slate-600">外れ</div>
                  </div>
                </div>
              </div>
            )}

            {loadingRacesForResult ? (
              <div className="flex justify-center py-3"><Spinner size={4} /></div>
            ) : racesForResult.length === 0 && !Object.keys(resultFeedback).length ? (
              <p className="text-xs text-slate-500 text-center py-3 bg-[#080c18] rounded-xl leading-relaxed">
                照合待ちのレースがありません<br />
                <span className="text-[10px]">「🔮 予想する」を押すとここにレースが表示されます</span>
              </p>
            ) : (
              <div className="space-y-3">
                {racesForResult.map((race) => {
                  const inputs = resultInputs[race.id] ?? { first: '', second: '' }
                  const isSubmitting = submittingResult === race.id
                  const err = resultError[race.id]
                  return (
                    <div key={race.id} className="bg-[#080c18] border border-[#1a2640] rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-bold text-white truncate">{race.name}</p>
                        <button
                          onClick={() => handleFetchResult(race.id)}
                          disabled={fetchingResult[race.id] || isSubmitting}
                          className="shrink-0 ml-2 px-2 py-1 rounded-lg text-[10px] font-bold bg-indigo-900/60 border border-indigo-600/40 text-indigo-300 hover:bg-indigo-800/60 transition-all disabled:opacity-50 flex items-center gap-1"
                        >
                          {fetchingResult[race.id] ? <><Spinner size={2} /><span>取得中...</span></> : <><span>🌐</span><span>自動取得</span></>}
                        </button>
                      </div>
                      {/* 予想内容をコンパクトに表示 */}
                      <div className="flex flex-wrap gap-1 mb-2">
                        {race.predictions.map((p) => (
                          <span
                            key={p.rank}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                              p.rank === 1 ? 'border-yellow-500/50 text-yellow-400 bg-yellow-900/20'
                              : p.rank <= 3 ? 'border-slate-500/50 text-slate-300 bg-slate-800/50'
                              : 'border-slate-700/50 text-slate-500'
                            }`}
                          >
                            {p.rank}位 {p.horseName} {p.placeRate}%
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                          <p className="text-[9px] text-slate-500 mb-1">1着の馬名</p>
                          <input
                            type="text"
                            value={inputs.first}
                            onChange={(e) =>
                              setResultInputs((prev) => ({
                                ...prev,
                                [race.id]: { ...(prev[race.id] ?? { first: '', second: '' }), first: e.target.value },
                              }))
                            }
                            placeholder="例: ドウデュース"
                            className="w-full bg-[#0f1729] border border-[#1e2d4a] rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-teal-400/50"
                          />
                        </div>
                        <div className="flex-1">
                          <p className="text-[9px] text-slate-500 mb-1">2着の馬名</p>
                          <input
                            type="text"
                            value={inputs.second}
                            onChange={(e) =>
                              setResultInputs((prev) => ({
                                ...prev,
                                [race.id]: { ...(prev[race.id] ?? { first: '', second: '' }), second: e.target.value },
                              }))
                            }
                            placeholder="例: リバティアイランド"
                            className="w-full bg-[#0f1729] border border-[#1e2d4a] rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-teal-400/50"
                          />
                        </div>
                      </div>
                      {err && <p className="text-[10px] text-red-400 mb-2">{err}</p>}
                      <button
                        onClick={() => handleSubmitResult(race.id, inputs.first, inputs.second)}
                        disabled={!inputs.first.trim() || !inputs.second.trim() || isSubmitting}
                        className="w-full py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 text-white"
                      >
                        {isSubmitting ? (
                          <><Spinner size={3} /><span className="pulse-gold">照合・パターン分析中...</span></>
                        ) : (
                          <><span>📊</span><span>結果を入力してアルゴリズムを改善する</span></>
                        )}
                      </button>
                    </div>
                  )
                })}

                {/* 照合済みフィードバック */}
                {Object.entries(resultFeedback).map(([raceId, fb]) => {
                  const race = racesForResult.find((r) => r.id === raceId)
                  return (
                    <div key={raceId} className="bg-[#080c18] border border-teal-800/40 rounded-xl p-3 fade-in">
                      {race && <p className="text-[10px] text-slate-500 mb-1 truncate">{race.name}</p>}
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-sm font-black ${fb.accuracy >= 50 ? 'text-emerald-400' : 'text-orange-400'}`}>
                          {fb.accuracy}%
                        </span>
                        <span className="text-[10px] text-slate-400">{fb.missInfo}</span>
                      </div>
                      {fb.patternAnalysis && (
                        <div className="bg-[#0f1729] rounded-lg p-2.5 mb-2">
                          <p className="text-[9px] text-teal-400 font-bold mb-1">📈 パターン分析</p>
                          <p className="text-[10px] text-slate-300 leading-relaxed">{fb.patternAnalysis}</p>
                        </div>
                      )}
                      {fb.algorithmChange && (
                        <div className="bg-[#0f1729] rounded-lg p-2.5">
                          <p className="text-[9px] text-yellow-400 font-bold mb-1">🔧 アルゴリズム改善点</p>
                          <p className="text-[10px] text-slate-300 leading-relaxed">{fb.algorithmChange}</p>
                        </div>
                      )}
                      {fb.overallStats && (
                        <p className="text-[9px] text-slate-600 mt-2 text-right">
                          累積: {fb.overallStats.total}レース / 通算{fb.overallStats.accuracy}%
                        </p>
                      )}
                    </div>
                  )
                })}
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
            <button onClick={fetchRaces} className="mt-2 text-xs text-red-400 underline">再試行</button>
          </div>
        ) : races.length === 0 ? (
          <div className="bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-6 text-center">
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-slate-400 text-sm">この日曜日のG1レースは登録されていません。</p>
            <p className="text-slate-500 text-xs mt-2">DBシードを実行するか、管理者にお問い合わせください。</p>
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

        {/* 馬体重入力フォーム */}
        {selectedRace && (
          <div className="mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-4 py-3"
              onClick={() => setShowWeightForm(!showWeightForm)}
            >
              <span className="text-sm font-bold text-white flex items-center gap-2">
                <span>⚖️</span>
                <span>馬体重入力（任意）</span>
              </span>
              <div className="flex items-center gap-2">
                {(() => {
                  const filled = Object.values(horseWeightInputs).filter((v) => v.weight || v.weightChange).length
                  return filled > 0 ? (
                    <span className="text-[10px] text-yellow-400 font-bold">{filled}頭入力済み</span>
                  ) : (
                    <span className="text-[10px] text-slate-500">当日発表の体重で精度向上</span>
                  )
                })()}
                <span className="text-slate-500 text-xs">{showWeightForm ? '▲' : '▼'}</span>
              </div>
            </button>
            {showWeightForm && (
              <div className="px-4 pb-4 border-t border-[#1e2d4a]">
                {selectedRace.entries.length === 0 ? (
                  <div className="py-3 text-center">
                    <p className="text-xs text-slate-400">出走馬が未登録のため入力できません</p>
                    <p className="text-[10px] text-slate-500 mt-1">
                      「🧠 自己学習」→「↻ 週末レース 出走馬を再検証」を実行すると出走馬が登録されます
                    </p>
                  </div>
                ) : (
                <>
                <div className="grid grid-cols-[auto_1fr_68px_56px] gap-x-2 px-1 py-2">
                  <span className="text-[9px] text-slate-600"></span>
                  <span className="text-[9px] text-slate-600"></span>
                  <span className="text-[9px] text-slate-600 text-right">体重(kg)</span>
                  <span className="text-[9px] text-slate-600 text-right">前走比</span>
                </div>
                <div className="space-y-1.5">
                  {selectedRace.entries.map((entry) => {
                    const key = entry.horseName
                    const inputs = horseWeightInputs[key] ?? { weight: '', weightChange: '' }
                    return (
                      <div key={entry.horseNumber} className="grid grid-cols-[auto_1fr_68px_56px] gap-x-2 items-center">
                        <span className="text-[10px] text-slate-500 w-6 text-right">{entry.horseNumber}.</span>
                        <span className="text-xs text-white truncate">{entry.horseName}</span>
                        <input
                          type="number"
                          value={inputs.weight}
                          onChange={(e) =>
                            setHorseWeightInputs((prev) => ({
                              ...prev,
                              [key]: { ...(prev[key] ?? { weight: '', weightChange: '' }), weight: e.target.value },
                            }))
                          }
                          placeholder="480"
                          min={300}
                          max={700}
                          className="w-full bg-[#080c18] border border-[#1e2d4a] rounded-lg px-2 py-1 text-xs text-white text-right placeholder-slate-700 focus:outline-none focus:border-yellow-400/50"
                        />
                        <input
                          type="number"
                          value={inputs.weightChange}
                          onChange={(e) =>
                            setHorseWeightInputs((prev) => ({
                              ...prev,
                              [key]: { ...(prev[key] ?? { weight: '', weightChange: '' }), weightChange: e.target.value },
                            }))
                          }
                          placeholder="±0"
                          className="w-full bg-[#080c18] border border-[#1e2d4a] rounded-lg px-2 py-1 text-xs text-white text-right placeholder-slate-700 focus:outline-none focus:border-yellow-400/50"
                        />
                      </div>
                    )
                  })}
                </div>
                {Object.values(horseWeightInputs).some((v) => v.weight || v.weightChange) && (
                  <button
                    onClick={() => setHorseWeightInputs({})}
                    className="mt-3 text-[10px] text-slate-500 hover:text-red-400 transition-colors"
                  >
                    入力クリア
                  </button>
                )}
                </>
                )}
              </div>
            )}
          </div>
        )}

        {/* 天気・馬場状態カード */}
        {selectedRace && (
          <div className="mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold text-white flex items-center gap-2">
                <span>🌤️</span>
                <span>当日天気・馬場状態</span>
              </span>
              {fetchingWeather && <span className="text-[10px] text-slate-400">取得中...</span>}
            </div>
            {weatherData && !fetchingWeather && (
              <div className="flex items-center gap-3 mb-3 text-sm">
                <span className="text-2xl">{weatherData.icon}</span>
                <div>
                  <span className="text-white font-bold">{weatherData.weather}</span>
                  <span className="text-slate-400 ml-2">{weatherData.temperature}°C</span>
                  {weatherData.precipMm > 0 && (
                    <span className="text-slate-400 ml-2">降水{weatherData.precipMm.toFixed(1)}mm</span>
                  )}
                </div>
              </div>
            )}
            {!weatherData && !fetchingWeather && (
              <p className="text-xs text-slate-500 mb-3">天気データを取得できませんでした</p>
            )}
            <div>
              <p className="text-[10px] text-slate-500 mb-1.5">馬場状態を選択</p>
              <div className="flex gap-2">
                {(['良', '稍重', '重', '不良'] as const).map((cond) => (
                  <button
                    key={cond}
                    onClick={() => setTrackCondition(cond)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      trackCondition === cond
                        ? 'bg-yellow-400 text-black'
                        : 'bg-[#080c18] border border-[#1e2d4a] text-slate-400 hover:border-yellow-400/50'
                    }`}
                  >
                    {cond}
                  </button>
                ))}
              </div>
            </div>
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

            {analysis && (
              <div className="mb-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-yellow-400">🔍</span>
                  <p className="text-xs font-bold text-yellow-400">レース展望</p>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{analysis}</p>
              </div>
            )}

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
                      <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${rankColors[i]} flex items-center justify-center flex-shrink-0`}>
                        <span className="text-black font-black text-sm">{rankLabels[i]}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {pred.horseNumber && (
                            <span className="text-xs text-slate-500 font-mono">{pred.horseNumber}番</span>
                          )}
                          <span className="text-base font-bold text-white truncate">{pred.horseName}</span>
                        </div>
                        <PlaceRateBar rate={pred.placeRate} />
                      </div>
                      <span className="text-slate-600 text-xs flex-shrink-0">{expandedCard === i ? '▲' : '▼'}</span>
                    </div>
                  </button>
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

            {/* インライン結果入力 */}
            {selectedRace && (() => {
              const raceDate = new Date(selectedRace.date)
              const isRacePast = raceDate <= today
              const feedback = resultFeedback[selectedRace.id]
              const inputs = resultInputs[selectedRace.id] ?? { first: '', second: '' }
              const isSubmitting = submittingResult === selectedRace.id
              const err = resultError[selectedRace.id]

              return (
                <div className="mt-4 bg-[#0f1729] border border-[#1e2d4a] rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span>📊</span>
                    <h3 className="text-sm font-bold text-white">予想結果の照合</h3>
                  </div>

                  {feedback ? (
                    <div className="fade-in">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-lg font-black ${feedback.accuracy >= 50 ? 'text-emerald-400' : 'text-orange-400'}`}>
                          {feedback.accuracy}%
                        </span>
                        <span className="text-xs text-slate-400">{feedback.missInfo}</span>
                      </div>
                      {feedback.patternAnalysis && (
                        <div className="bg-[#080c18] rounded-xl p-3 mb-2">
                          <p className="text-[9px] text-teal-400 font-bold mb-1">📈 パターン分析</p>
                          <p className="text-[10px] text-slate-300 leading-relaxed">{feedback.patternAnalysis}</p>
                        </div>
                      )}
                      {feedback.algorithmChange && (
                        <div className="bg-[#080c18] rounded-xl p-3">
                          <p className="text-[9px] text-yellow-400 font-bold mb-1">🔧 アルゴリズム改善点</p>
                          <p className="text-[10px] text-slate-300 leading-relaxed">{feedback.algorithmChange}</p>
                        </div>
                      )}
                      {feedback.overallStats && (
                        <p className="text-[9px] text-slate-600 mt-2 text-right">
                          累積: {feedback.overallStats.total}レース / 通算{feedback.overallStats.accuracy}%
                        </p>
                      )}
                    </div>
                  ) : isRacePast ? (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          結果を入力するとアルゴリズムが自動改善します
                        </p>
                        <button
                          onClick={() => handleFetchResult(selectedRace.id)}
                          disabled={fetchingResult[selectedRace.id] || submittingResult === selectedRace.id}
                          className="shrink-0 ml-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-900/60 border border-indigo-600/40 text-indigo-300 hover:bg-indigo-800/60 transition-all disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {fetchingResult[selectedRace.id]
                            ? <><Spinner size={3} /><span>取得中...</span></>
                            : <><span>🌐</span><span>ネットから自動取得</span></>}
                        </button>
                      </div>
                      <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                          <p className="text-[9px] text-slate-500 mb-1">1着の馬名</p>
                          <input
                            type="text"
                            value={inputs.first}
                            onChange={(e) =>
                              setResultInputs((prev) => ({
                                ...prev,
                                [selectedRace.id]: { ...(prev[selectedRace.id] ?? { first: '', second: '' }), first: e.target.value },
                              }))
                            }
                            placeholder="例: ドウデュース"
                            className="w-full bg-[#080c18] border border-[#1e2d4a] rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-teal-400/50"
                          />
                        </div>
                        <div className="flex-1">
                          <p className="text-[9px] text-slate-500 mb-1">2着の馬名</p>
                          <input
                            type="text"
                            value={inputs.second}
                            onChange={(e) =>
                              setResultInputs((prev) => ({
                                ...prev,
                                [selectedRace.id]: { ...(prev[selectedRace.id] ?? { first: '', second: '' }), second: e.target.value },
                              }))
                            }
                            placeholder="例: リバティアイランド"
                            className="w-full bg-[#080c18] border border-[#1e2d4a] rounded-lg px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-teal-400/50"
                          />
                        </div>
                      </div>
                      {err && <p className="text-[10px] text-red-400 mb-2">{err}</p>}
                      <button
                        onClick={() => handleSubmitResult(selectedRace.id, inputs.first, inputs.second)}
                        disabled={!inputs.first.trim() || !inputs.second.trim() || isSubmitting}
                        className="w-full py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 text-white"
                      >
                        {isSubmitting ? (
                          <><Spinner size={3} /><span className="pulse-gold">照合・パターン分析中...</span></>
                        ) : (
                          <><span>📊</span><span>結果を入力してアルゴリズムを改善する</span></>
                        )}
                      </button>
                    </>
                  ) : (
                    <div className="py-2 text-center">
                      <p className="text-xs text-slate-400">
                        レース終了後（{format(new Date(selectedRace.date), 'M月d日(E)', { locale: ja })}以降）に
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">ここに1着・2着を入力するとAIが自動改善します</p>
                      <p className="text-[10px] text-slate-500 mt-2">
                        ※ 予想は保存されました。レース後に再度アクセスしてください
                      </p>
                    </div>
                  )}
                </div>
              )
            })()}

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

      <div className="h-8" />
    </div>
  )
}
