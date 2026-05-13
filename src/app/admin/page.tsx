'use client'

import { useState, useEffect, useRef } from 'react'
import type { TaskKey, TaskStatus } from '@/app/api/admin/run-task/route'

interface AdminStats {
  db: {
    raceCount: number
    resultCount: number
    horseCount: number
    predCount: number
    lastIngestion: string | null
    lastRaceDate: string | null
  }
  kpi: {
    total: number
    hit1: number
    hit2: number
    hit1Rate: number | null
    hit2Rate: number | null
  }
  ml: {
    feature_cols?: string[]
    best_iteration?: number
    test_auc?: number
    test_loss?: number
    hit1_rate?: number
    hit2_rate?: number
    trained_at?: string
    n_train?: number
    n_test?: number
  } | null
  algo: {
    version: number
    accuracy: number | null
    analyzedCount: number
    updatedAt: string
    insights: Record<string, unknown>
  } | null
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-4 ${highlight ? 'bg-green-900/40 border border-green-700' : 'bg-gray-800 border border-gray-700'}`}>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono ${highlight ? 'text-green-300' : 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{title}</h2>
      {children}
    </div>
  )
}

const TASK_DEFS: { key: TaskKey; label: string; desc: string; color: string }[] = [
  { key: 'weekly_update',  label: '結果取り込み',     desc: '前回実行日〜今日のJRAレース結果をDBに取り込み、HorseStat再構築・KPI評価まで実行', color: 'blue' },
  { key: 'weekly_prefetch', label: '翌週末事前取り込み', desc: '今週末の出走表を事前に取得してDBに登録（金曜実行想定）', color: 'teal' },
  { key: 'ml_dataset',    label: 'データセット生成',  desc: 'DB全レース結果からLightGBM訓練用dataset.parquetを生成（2021-01-01〜今日）', color: 'amber' },
  { key: 'ml_retrain',    label: 'LightGBM再訓練',   desc: 'dataset.parquetを使ってモデルを再訓練しmodel.onnxを更新', color: 'purple' },
]

const COLOR_MAP: Record<string, string> = {
  blue:   'bg-blue-700 hover:bg-blue-600 disabled:bg-blue-900',
  teal:   'bg-teal-700 hover:bg-teal-600 disabled:bg-teal-900',
  amber:  'bg-amber-700 hover:bg-amber-600 disabled:bg-amber-900',
  purple: 'bg-purple-700 hover:bg-purple-600 disabled:bg-purple-900',
}

export default function AdminPage() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [reanalyzMsg, setReanalyzMsg] = useState<string | null>(null)
  const [taskStatuses, setTaskStatuses] = useState<Record<string, TaskStatus>>({})
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function fetchStats() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/stats')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStats(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStats() }, [])

  // タスク状態ポーリング（実行中のタスクがある間 3秒ごと）
  async function pollTaskStatuses() {
    try {
      const res = await fetch('/api/admin/run-task')
      if (!res.ok) return
      const data: Record<string, TaskStatus> = await res.json()
      setTaskStatuses(data)
      const anyRunning = Object.values(data).some(s => s.running)
      if (anyRunning) {
        pollRef.current = setTimeout(pollTaskStatuses, 3000)
      } else {
        pollRef.current = null
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [])

  async function runTask(task: TaskKey) {
    try {
      const res = await fetch('/api/admin/run-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      })
      const data = await res.json()
      if (data.status === 'started' || data.status === 'already_running') {
        // ポーリング開始（既に動いている場合は再スケジュールしない）
        if (!pollRef.current) {
          pollRef.current = setTimeout(pollTaskStatuses, 500)
        }
      }
    } catch (e) {
      console.error('runTask error', e)
    }
  }

  async function runReanalyze() {
    setReanalyzing(true)
    setReanalyzMsg(null)
    try {
      const res = await fetch('/api/reanalyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json()
      setReanalyzMsg(data.summary ?? JSON.stringify(data))
      await fetchStats()
    } catch (e) {
      setReanalyzMsg(e instanceof Error ? e.message : 'error')
    } finally {
      setReanalyzing(false)
    }
  }

  function fmt(n: number | null | undefined, digits = 0) {
    if (n == null) return '—'
    return n.toLocaleString('ja-JP', { maximumFractionDigits: digits })
  }

  function fmtDate(iso: string | null | undefined) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
  }

  function fmtPct(rate: number | null | undefined) {
    if (rate == null) return '—'
    return `${(rate * 100).toFixed(1)}%`
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">管理ダッシュボード</h1>
            <p className="text-gray-500 text-sm mt-1">競馬予想システム v400</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={fetchStats}
              disabled={loading}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
            >
              更新
            </button>
            <button
              onClick={runReanalyze}
              disabled={reanalyzing}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded text-sm disabled:opacity-50"
            >
              {reanalyzing ? '再解析中…' : 'HorseStat再構築'}
            </button>
            <a href="/" className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">
              予想画面
            </a>
          </div>
        </div>

        {reanalyzMsg && (
          <div className="mb-4 p-3 bg-blue-900/50 border border-blue-700 rounded text-sm text-blue-200">
            {reanalyzMsg}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-sm text-red-200">
            エラー: {error}
          </div>
        )}

        {loading && !stats ? (
          <div className="text-gray-500 text-center py-20">読み込み中…</div>
        ) : stats ? (
          <>
            <Section title="データベース">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="総レース数" value={fmt(stats.db.raceCount)} sub="Race テーブル" />
                <Stat label="総結果数" value={fmt(stats.db.resultCount)} sub="RaceResult テーブル" />
                <Stat label="HorseStat" value={fmt(stats.db.horseCount)} sub="頭" />
                <Stat label="予想生成数" value={fmt(stats.db.predCount)} sub="Prediction テーブル" />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Stat label="最新レース日" value={fmtDate(stats.db.lastRaceDate)} />
                <Stat label="最終取り込み" value={fmtDate(stats.db.lastIngestion)} />
              </div>
            </Section>

            <Section title={`直近${stats.kpi.total}レース KPI`}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat
                  label="Hit@5(1) 目標92%"
                  value={fmtPct(stats.kpi.hit1Rate)}
                  sub={`${stats.kpi.hit1}/${stats.kpi.total}`}
                  highlight={(stats.kpi.hit1Rate ?? 0) >= 0.92}
                />
                <Stat
                  label="Hit@5(2) 目標35%"
                  value={fmtPct(stats.kpi.hit2Rate)}
                  sub={`${stats.kpi.hit2}/${stats.kpi.total}`}
                  highlight={(stats.kpi.hit2Rate ?? 0) >= 0.35}
                />
                <Stat label="評価対象" value={fmt(stats.kpi.total)} sub="予想+結果あり" />
                <Stat label="ヒット2頭以上" value={fmt(stats.kpi.hit2)} sub="件" />
              </div>
            </Section>

            {stats.ml && (
              <Section title="ML モデル (LightGBM + ONNX)">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat
                    label="Test AUC"
                    value={stats.ml.test_auc != null ? stats.ml.test_auc.toFixed(4) : '—'}
                    highlight={(stats.ml.test_auc ?? 0) >= 0.99}
                  />
                  <Stat
                    label="LogLoss"
                    value={stats.ml.test_loss != null ? stats.ml.test_loss.toFixed(4) : '—'}
                  />
                  <Stat
                    label="ML Hit@5(1)"
                    value={fmtPct(stats.ml.hit1_rate)}
                  />
                  <Stat
                    label="ML Hit@5(2)"
                    value={fmtPct(stats.ml.hit2_rate)}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Stat label="特徴量数" value={fmt(stats.ml.feature_cols?.length)} sub="次元" />
                  <Stat label="訓練件数" value={fmt(stats.ml.n_train)} sub="行" />
                  <Stat label="訓練日時" value={stats.ml.trained_at ? new Date(stats.ml.trained_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'} />
                </div>
                {stats.ml.feature_cols && (
                  <div className="mt-3 p-3 bg-gray-800 rounded text-xs text-gray-400 font-mono leading-5">
                    <span className="text-gray-500">特徴量: </span>
                    {stats.ml.feature_cols.join(' · ')}
                  </div>
                )}
              </Section>
            )}

            {!stats.ml && (
              <Section title="ML モデル">
                <div className="p-4 bg-gray-800 rounded text-sm text-gray-400">
                  ml/models/meta.json が見つかりません。MLパイプラインを実行してください。
                  <div className="mt-2 font-mono text-xs text-gray-500">
                    python ml/build_dataset.py --from=2021-01-01 --to=2026-05-13 --out=ml/dataset.parquet<br />
                    python ml/train.py --dataset=ml/dataset.parquet --out-dir=ml/models
                  </div>
                </div>
              </Section>
            )}

            {stats.algo && (
              <Section title="アルゴリズム設定">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="バージョン" value={`v${stats.algo.version}`} />
                  <Stat label="推定精度" value={stats.algo.accuracy != null ? `${stats.algo.accuracy.toFixed(1)}%` : '—'} />
                  <Stat label="分析済みレース" value={fmt(stats.algo.analyzedCount)} sub="件" />
                  <Stat label="最終更新" value={fmtDate(stats.algo.updatedAt)} />
                </div>
              </Section>
            )}

            <Section title="タスク強制実行">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {TASK_DEFS.map(({ key, label, desc, color }) => {
                  const s = taskStatuses[key]
                  const isRunning = s?.running ?? false
                  const isDone = !isRunning && s?.finishedAt
                  const isError = isDone && s?.exitCode !== 0
                  const btnClass = `px-3 py-1.5 rounded text-xs font-semibold text-white transition disabled:opacity-60 disabled:cursor-not-allowed ${COLOR_MAP[color]}`
                  const elapsed = isRunning && s?.startedAt
                    ? `${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000)}秒`
                    : null

                  return (
                    <div key={key} className="p-4 bg-gray-800 rounded border border-gray-700 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-medium text-sm flex items-center gap-2">
                            {label}
                            {isRunning && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 animate-pulse">
                                実行中{elapsed ? ` ${elapsed}` : ''}
                              </span>
                            )}
                            {isDone && !isError && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/60 text-green-300">完了</span>
                            )}
                            {isError && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/60 text-red-300">
                                エラー (exit {s.exitCode})
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">{desc}</div>
                        </div>
                        <button
                          onClick={() => runTask(key)}
                          disabled={isRunning}
                          className={btnClass}
                        >
                          {isRunning ? '実行中…' : '実行'}
                        </button>
                      </div>
                      {s?.lastLines && s.lastLines.length > 0 && (
                        <pre className="text-[10px] text-gray-400 bg-gray-900 rounded p-2 max-h-28 overflow-y-auto whitespace-pre-wrap leading-4">
                          {s.lastLines.slice(-30).join('\n')}
                        </pre>
                      )}
                      {isDone && s?.startedAt && s?.finishedAt && (
                        <div className="text-[10px] text-gray-600">
                          {new Date(s.startedAt).toLocaleTimeString('ja-JP')} →{' '}
                          {new Date(s.finishedAt).toLocaleTimeString('ja-JP')}（
                          {Math.round((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)}秒）
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-gray-600 mt-2">
                ※ 結果取り込みは前回実行日の翌日から今日まで自動判定。何度実行しても重複なし。
              </p>
            </Section>

            <Section title="操作（コマンドリファレンス）">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="p-4 bg-gray-800 rounded border border-gray-700">
                  <div className="font-medium mb-2">データ取り込み</div>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded mb-2">
                    node scripts/fetch_jra_full_calendar.js --from=2026-05-01 --to=2026-05-13
                  </code>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded">
                    node scripts/reanalyze.js
                  </code>
                </div>
                <div className="p-4 bg-gray-800 rounded border border-gray-700">
                  <div className="font-medium mb-2">ML再訓練</div>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded mb-2">
                    python ml/build_dataset.py --from=2021-01-01 --to=2026-05-13 --out=ml/dataset.parquet
                  </code>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded">
                    python ml/train.py --dataset=ml/dataset.parquet --out-dir=ml/models
                  </code>
                </div>
                <div className="p-4 bg-gray-800 rounded border border-gray-700">
                  <div className="font-medium mb-2">KPI評価</div>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded">
                    node scripts/eval_full.js --from=2025-01-01
                  </code>
                </div>
                <div className="p-4 bg-gray-800 rounded border border-gray-700">
                  <div className="font-medium mb-2">週次更新（自動）</div>
                  <code className="block text-xs text-gray-400 bg-gray-900 p-2 rounded">
                    node scripts/weekly_update.js
                  </code>
                </div>
              </div>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  )
}
