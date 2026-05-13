'use strict'
/**
 * Windows トースト通知ヘルパー
 * BurntToast モジュールが未インストールの場合はログ出力のみ
 *
 * 使い方:
 *   const { notify } = require('./lib/notify')
 *   notify('KPI更新', 'Hit@5(2)=68% — 目標超過')
 */
const { execSync } = require('child_process')

function notify(title, body) {
  const safeTitle = String(title).replace(/"/g, "'")
  const safeBody  = String(body).replace(/"/g, "'")
  console.log(`[通知] ${safeTitle}: ${safeBody}`)
  try {
    execSync(
      `powershell -NonInteractive -Command "` +
      `$m = Get-Module BurntToast -ListAvailable; ` +
      `if ($m) { Import-Module BurntToast; New-BurntToastNotification -Text '${safeTitle}', '${safeBody}' } ` +
      `else { [System.Windows.Forms.MessageBox]::Show('${safeBody}', '${safeTitle}') | Out-Null }"`,
      { stdio: 'ignore', timeout: 5000 }
    )
  } catch { /* 通知失敗は無視 */ }
}

module.exports = { notify }
