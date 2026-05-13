# Windows タスクスケジューラ 自動運用セットアップ
# 実行: powershell -ExecutionPolicy Bypass -File C:\keiba\scripts\setup_task_scheduler.ps1

$nodeExe   = (Get-Command node -ErrorAction SilentlyContinue).Source
$pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
$logDir    = "C:\keiba\logs"
$keibaDir  = "C:\keiba"

if (-not $nodeExe)   { Write-Error "node が見つかりません。Node.js をインストールしてください。"; exit 1 }
if (-not $pythonExe) { Write-Warning "python が見つかりません。MLパイプラインタスクはスキップします。" }

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

Write-Host "=== 競馬予想システム タスクスケジューラ セットアップ ===" -ForegroundColor Cyan
Write-Host "node: $nodeExe"
Write-Host "python: $($pythonExe ?? '未検出')"
Write-Host "ログ: $logDir"
Write-Host ""

# ---- タスク1: 週次更新（毎週月曜 10:00） ----
# PC稼働時間: 9:00〜21:00。StartWhenAvailable で電源ON後すみやかに実行。
# 前回実行日から今日までの欠落分を自動回復する。
$task1Name = "KeibaWeeklyUpdate"
$task1Cmd  = "$nodeExe $keibaDir\scripts\weekly_update.js"
$task1Log  = "$logDir\weekly_update.log"

$trigger1  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "10:00"
$action1   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/C `"$task1Cmd >> `"$task1Log`" 2>&1`""
$settings1 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -StartWhenAvailable

Unregister-ScheduledTask -TaskName $task1Name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName $task1Name `
  -Trigger $trigger1 `
  -Action $action1 `
  -Settings $settings1 `
  -RunLevel Highest `
  -Description "JRA前回実行日〜今日のレース取込み + HorseStat再構築（欠落自動回復）" | Out-Null
Write-Host "[OK] $task1Name — 毎週月曜 10:00（StartWhenAvailable）" -ForegroundColor Green

# ---- タスク2: 週次事前取り込み（毎週金曜 12:00） ----
$task2Name = "KeibaWeeklyPrefetch"
$task2Cmd  = "$nodeExe $keibaDir\scripts\weekly_prefetch.js"
$task2Log  = "$logDir\weekly_prefetch.log"

$trigger2  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "12:00"
$action2   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/C `"$task2Cmd >> `"$task2Log`" 2>&1`""
$settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable

Unregister-ScheduledTask -TaskName $task2Name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName $task2Name `
  -Trigger $trigger2 `
  -Action $action2 `
  -Settings $settings2 `
  -RunLevel Highest `
  -Description "翌週末レース事前取り込み（金曜昼）" | Out-Null
Write-Host "[OK] $task2Name — 毎週金曜 12:00" -ForegroundColor Green

# ---- タスク3&4: ML月次再訓練（毎月1日 03:00） ----
if ($pythonExe) {
  $task3Name = "KeibaMLDataset"
  $task3Cmd  = "$pythonExe $keibaDir\ml\build_dataset.py --from=2021-01-01 --to=%(今日) --out=$keibaDir\ml\dataset.parquet"
  # 動的に --to=<today> を渡すためバッチ経由
  $task3Batch = @"
@echo off
set TODAY=%date:~0,4%-%date:~5,2%-%date:~8,2%
$pythonExe $keibaDir\ml\build_dataset.py --from=2021-01-01 "--to=%TODAY%" --out=$keibaDir\ml\dataset.parquet >> $logDir\ml_dataset.log 2>&1
"@
  $batchDir = "$keibaDir\scripts"
  Set-Content -Path "$batchDir\ml_dataset.bat" -Value $task3Batch -Encoding utf8

  $trigger3  = New-ScheduledTaskTrigger -Monthly -DaysOfMonth 1 -At "10:00"
  $action3   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/C `"$batchDir\ml_dataset.bat`""
  $settings3 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable

  Unregister-ScheduledTask -TaskName $task3Name -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask `
    -TaskName $task3Name `
    -Trigger $trigger3 `
    -Action $action3 `
    -Settings $settings3 `
    -RunLevel Highest `
    -Description "ML訓練データセット生成（毎月1日10:00）" | Out-Null
  Write-Host "[OK] $task3Name — 毎月1日 10:00 (dataset)" -ForegroundColor Green

  $task4Name = "KeibaMLRetrain"
  $task4Cmd  = "$pythonExe $keibaDir\ml\train.py --dataset=$keibaDir\ml\dataset.parquet --out-dir=$keibaDir\ml\models"
  $trigger4  = New-ScheduledTaskTrigger -Monthly -DaysOfMonth 1 -At "11:00"
  $action4   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/C `"$task4Cmd >> $logDir\ml_retrain.log 2>&1`""
  $settings4 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable

  Unregister-ScheduledTask -TaskName $task4Name -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask `
    -TaskName $task4Name `
    -Trigger $trigger4 `
    -Action $action4 `
    -Settings $settings4 `
    -RunLevel Highest `
    -Description "LightGBM再訓練 → ONNX出力（毎月1日11:00）" | Out-Null
  Write-Host "[OK] $task4Name — 毎月1日 11:00 (retrain)" -ForegroundColor Green
} else {
  Write-Host "[SKIP] MLタスク (python未検出)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== セットアップ完了 ===" -ForegroundColor Cyan
Write-Host "登録タスク一覧:"
Get-ScheduledTask | Where-Object { $_.TaskName -like "Keiba*" } | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -ErrorAction SilentlyContinue
  Write-Host "  $($_.TaskName.PadRight(25)) 最終実行: $($info.LastRunTime)"
}
Write-Host ""
Write-Host "ログ確認: Get-Content $logDir\weekly_update.log -Tail 50"
