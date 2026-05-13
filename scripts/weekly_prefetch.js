'use strict'
/**
 * 週次事前取り込みスクリプト（毎週金曜実行）
 *
 * 翌週末（土日）のレースカレンダーを先行取り込みする。
 * 出走馬確定前なので結果0件が正常。カレンダーのみ登録されることが多い。
 *
 * 使い方:
 *   node scripts/weekly_prefetch.js
 *   node scripts/weekly_prefetch.js --dry-run
 *
 * Windows タスクスケジューラ設定例:
 *   タスク名: keiba-weekly-prefetch
 *   トリガー: 毎週金曜 12:00
 *   操作: node C:\keiba\scripts\weekly_prefetch.js >> C:\keiba\logs\weekly_prefetch.log 2>&1
 */
const { spawn } = require('child_process')
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

function getNextWeekend() {
  const today = new Date()
  const dow = today.getDay()  // 0=日, 1=月, ..., 6=土
  // 次の土曜を基点に土日を返す
  const daysUntilSat = ((6 - dow) + 7) % 7 || 7
  const nextSaturday = new Date(today)
  nextSaturday.setDate(today.getDate() + daysUntilSat)
  const nextSunday = new Date(nextSaturday)
  nextSunday.setDate(nextSaturday.getDate() + 1)
  return { from: toIsoDate(nextSaturday), to: toIsoDate(nextSunday) }
}

async function main() {
  const { from, to } = getNextWeekend()
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] === 週次事前取り込み開始 ===`)
  console.log(`  対象: ${from} ～ ${to} (翌週末)${dryRun ? ' (dry-run)' : ''}`)

  const fetchScript = path.join(__dirname, 'fetch_jra_full_calendar.js')
  const args = [`--from=${from}`, `--to=${to}`]
  if (dryRun) args.push('--dry-run')

  return new Promise((resolve) => {
    const proc = spawn('node', [fetchScript, ...args], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    })
    proc.on('close', (code) => {
      console.log(`  事前取り込み完了 (exit ${code})`)
      console.log(`  ※ 出走馬確定前のため結果0件は正常です。`)
      console.log(`  ※ 当日朝（土曜5時・日曜5時）に weekly_update.js が結果を確定取り込みします。`)
      console.log(`[${new Date().toISOString()}] === 週次事前取り込み完了 ===\n`)
      resolve()
    })
  })
}

main().catch(err => { console.error(err); process.exit(1) })
