'use strict'
/**
 * 週次自動更新スクリプト（毎週月曜実行）
 *
 * 1. 先週末（土日）の全レースを取り込む
 * 2. HorseStat を再構築（POST /api/reanalyze）
 * 3. 取込み結果をログ出力
 *
 * 使い方:
 *   node scripts/weekly_update.js
 *   node scripts/weekly_update.js --dry-run
 *
 * Windows タスクスケジューラ設定例:
 *   タスク名: keiba-weekly-update
 *   トリガー: 毎週月曜 7:00
 *   操作: node C:\keiba\scripts\weekly_update.js >> C:\keiba\logs\weekly_update.log 2>&1
 */
const { execSync, spawn } = require('child_process')
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

function toIsoDate(d) {
  return d.toISOString().split('T')[0]
}

function getLastWeekend() {
  const today = new Date()
  const dow = today.getDay()  // 0=日, 1=月, ..., 6=土
  // 直近の日曜を基点に前の土日を計算
  const lastSunday = new Date(today)
  lastSunday.setDate(today.getDate() - (dow === 0 ? 0 : dow))
  const lastSaturday = new Date(lastSunday)
  lastSaturday.setDate(lastSunday.getDate() - 1)
  return { from: toIsoDate(lastSaturday), to: toIsoDate(lastSunday) }
}

async function main() {
  const { from, to } = getLastWeekend()
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] === 週次更新開始 ===`)
  console.log(`  対象: ${from} ～ ${to}${dryRun ? ' (dry-run)' : ''}`)

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
