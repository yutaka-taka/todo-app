'use strict'
/**
 * 週次自動更新スクリプト
 *
 * 前回実行日から今日までの全レースを取り込む（欠落期間を自動回復）。
 * 前回実行日は logs/last_update_date.txt に保存。
 * 初回実行時は14日前をデフォルトとして使用。
 *
 * 使い方:
 *   node scripts/weekly_update.js
 *   node scripts/weekly_update.js --dry-run
 *   node scripts/weekly_update.js --from=2026-04-01  # 手動で開始日を上書き
 *
 * Windows タスクスケジューラ:
 *   タスク名: KeibaWeeklyUpdate
 *   トリガー: 毎週月曜 10:00（StartWhenAvailable有効 → 起動時に遅延実行）
 *   操作: node C:\keiba\scripts\weekly_update.js >> C:\keiba\logs\weekly_update.log 2>&1
 */
const { spawn, spawnSync } = require('child_process')
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

const dryRun = process.argv.includes('--dry-run')
const LOG_DIR = path.join(__dirname, '..', 'logs')
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// 前回実行日を保存するファイル
const STATE_FILE = path.join(LOG_DIR, 'last_update_date.txt')

function toIsoDate(d) {
  return d.toISOString().split('T')[0]
}

function getFetchRange() {
  // --from 引数で手動上書き可能
  const fromArg = process.argv.find(a => a.startsWith('--from='))
  if (fromArg) {
    return { from: fromArg.split('=')[1], to: toIsoDate(new Date()), manual: true }
  }

  let from
  try {
    const saved = fs.readFileSync(STATE_FILE, 'utf-8').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(saved)) {
      // 前回実行日の翌日から今日まで
      const d = new Date(saved)
      d.setDate(d.getDate() + 1)
      from = toIsoDate(d)
    }
  } catch { /* ファイルなし → 初回 */ }

  if (!from) {
    // 初回実行: 14日前をデフォルト
    const d = new Date()
    d.setDate(d.getDate() - 14)
    from = toIsoDate(d)
    console.log(`  [初回] last_update_date.txt が未作成のため ${from} から取り込みます`)
  }

  return { from, to: toIsoDate(new Date()), manual: false }
}

function saveLastUpdateDate(dateStr) {
  fs.writeFileSync(STATE_FILE, dateStr, 'utf-8')
}

async function main() {
  const { from, to, manual } = getFetchRange()
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] === 週次更新開始 ===`)
  console.log(`  対象: ${from} ～ ${to}${manual ? ' (手動指定)' : ''}${dryRun ? ' (dry-run)' : ''}`)

  // 同日 or from > to の場合はスキップ（既に最新）
  if (from > to) {
    console.log('  既に最新状態です。スキップします。')
    console.log(`[${new Date().toISOString()}] === 週次更新完了（スキップ） ===\n`)
    return
  }

  // fetch_jra_full_calendar.js を実行
  const fetchScript = path.join(__dirname, 'fetch_jra_full_calendar.js')
  const args = [`--from=${from}`, `--to=${to}`]
  if (dryRun) args.push('--dry-run')

  return new Promise((resolve) => {
    const proc = spawn('node', [fetchScript, ...args], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    })
    proc.on('close', async (code) => {
      console.log(`  取り込み完了 (exit ${code})`)

      // 成功・失敗問わず実行日を記録（次回は今日の翌日から取り込む）
      if (!dryRun) {
        saveLastUpdateDate(to)
        console.log(`  実行日を保存: ${STATE_FILE} → ${to}`)
      }

      if (!dryRun) {
        // HorseStat 再構築
        try {
          console.log('  HorseStat 再構築中...')
          const res = await fetch('http://localhost:3000/api/reanalyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
          if (res.ok) {
            const data = await res.json()
            console.log(`  HorseStat 再構築完了: ${data.horsesSaved ?? '?'} 頭`)
          } else {
            console.warn(`  HorseStat 再構築 HTTP ${res.status}`)
          }
        } catch (err) {
          console.error('  HorseStat 再構築失敗:', err.message)
          console.log('  (アプリが起動していない場合は手動で POST /api/reanalyze を実行してください)')
        }
      }

      // KPI 評価 → .evaluation_log.json 追記
      if (!dryRun) {
        try {
          console.log('  KPI 評価中...')
          const evalScript = path.join(__dirname, 'eval_full.js')
          const evalProc = require('child_process').spawnSync(
            'node', [evalScript, '--log', '--from=2025-01-01'],
            { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: process.env }
          )
          if (evalProc.status !== 0) console.warn('  KPI 評価失敗 (exit', evalProc.status, ')')
        } catch (e) {
          console.warn('  KPI 評価失敗:', e.message)
        }
      }

      console.log(`[${new Date().toISOString()}] === 週次更新完了 ===\n`)
      resolve()
    })
  })
}

main().catch(err => { console.error(err); process.exit(1) })
