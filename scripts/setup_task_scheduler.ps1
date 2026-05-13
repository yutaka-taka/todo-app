# Keiba Task Scheduler Setup
# Auto-elevates to Administrator if needed.
# Run: powershell -ExecutionPolicy Bypass -File C:\keiba\scripts\setup_task_scheduler.ps1

# ---- Auto-elevate ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting administrator privileges..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

$nodeExe   = (Get-Command node -ErrorAction SilentlyContinue).Source
$pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
$logDir    = "C:\keiba\logs"
$keibaDir  = "C:\keiba"

if (-not $nodeExe) { Write-Error "node not found. Please install Node.js."; Read-Host "Press Enter"; exit 1 }
if (-not $pythonExe) { Write-Warning "python not found. ML tasks will be skipped." }

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

$pythonDisplay = if ($pythonExe) { $pythonExe } else { "not found" }

Write-Host "=== Keiba Task Scheduler Setup ===" -ForegroundColor Cyan
Write-Host "node  : $nodeExe"
Write-Host "python: $pythonDisplay"
Write-Host "logs  : $logDir"
Write-Host ""

# ---- Task 1: Weekly update (every Monday 10:00) ----
$task1Name = "KeibaWeeklyUpdate"
$task1Log  = "$logDir\weekly_update.log"
$task1Script = "$keibaDir\scripts\weekly_update.js"

Unregister-ScheduledTask -TaskName $task1Name -Confirm:$false -ErrorAction SilentlyContinue

$trigger1  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "10:00"
$action1   = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/C `"`"$nodeExe`" `"$task1Script`" >> `"$task1Log`" 2>&1`""
$settings1 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $task1Name `
  -Trigger $trigger1 `
  -Action $action1 `
  -Settings $settings1 `
  -RunLevel Highest `
  -Force `
  -Description "JRA race fetch (last-run to today) + HorseStat rebuild" | Out-Null
Write-Host "[OK] $task1Name -- Every Monday 10:00 (StartWhenAvailable)" -ForegroundColor Green

# ---- Task 2: Weekly prefetch (every Friday 12:00) ----
$task2Name = "KeibaWeeklyPrefetch"
$task2Log  = "$logDir\weekly_prefetch.log"
$task2Script = "$keibaDir\scripts\weekly_prefetch.js"

Unregister-ScheduledTask -TaskName $task2Name -Confirm:$false -ErrorAction SilentlyContinue

$trigger2  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "12:00"
$action2   = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument "/C `"`"$nodeExe`" `"$task2Script`" >> `"$task2Log`" 2>&1`""
$settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $task2Name `
  -Trigger $trigger2 `
  -Action $action2 `
  -Settings $settings2 `
  -RunLevel Highest `
  -Force `
  -Description "Pre-fetch next weekend race list (Friday noon)" | Out-Null
Write-Host "[OK] $task2Name -- Every Friday 12:00" -ForegroundColor Green

# ---- Tasks 3 & 4: ML monthly retrain (1st of month 10:00 / 11:00) ----
# Use schtasks.exe for monthly schedule (New-ScheduledTaskTrigger -Monthly not available in PS 5.1)
if ($pythonExe) {
  $task3Name = "KeibaMLDataset"
  $task3Log  = "$logDir\ml_dataset.log"
  $batchPath = "$keibaDir\scripts\ml_dataset.bat"

  # Batch file for dynamic --to=TODAY
  $batchContent = "@echo off`r`nset TODAY=%date:~0,4%-%date:~5,2%-%date:~8,2%`r`n" +
    "`"$pythonExe`" `"$keibaDir\ml\build_dataset.py`" --from=2021-01-01 " +
    "`"--to=%TODAY%`" --out=`"$keibaDir\ml\dataset.parquet`" >> `"$task3Log`" 2>&1"
  [System.IO.File]::WriteAllText($batchPath, $batchContent, [System.Text.Encoding]::Default)

  schtasks.exe /delete /tn $task3Name /f 2>$null | Out-Null
  schtasks.exe /create /tn $task3Name /sc monthly /d 1 /st "10:00" `
    /tr "`"cmd.exe`" /C `"`"$batchPath`"`"" `
    /rl highest /f | Out-Null
  Write-Host "[OK] $task3Name -- 1st of month 10:00 (dataset)" -ForegroundColor Green

  $task4Name = "KeibaMLRetrain"
  $task4Log  = "$logDir\ml_retrain.log"
  $task4Cmd  = "`"$pythonExe`" `"$keibaDir\ml\train.py`" " +
    "--dataset=`"$keibaDir\ml\dataset.parquet`" " +
    "--out-dir=`"$keibaDir\ml\models`" >> `"$task4Log`" 2>&1"

  schtasks.exe /delete /tn $task4Name /f 2>$null | Out-Null
  schtasks.exe /create /tn $task4Name /sc monthly /d 1 /st "11:00" `
    /tr "`"cmd.exe`" /C `"$task4Cmd`"" `
    /rl highest /f | Out-Null
  Write-Host "[OK] $task4Name -- 1st of month 11:00 (retrain)" -ForegroundColor Green
} else {
  Write-Host "[SKIP] ML tasks (python not found)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host "Registered Keiba tasks:"
Get-ScheduledTask | Where-Object { $_.TaskName -like "Keiba*" } | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -ErrorAction SilentlyContinue
  $lastRun = "never"
  if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {
    $lastRun = $info.LastRunTime.ToString("yyyy-MM-dd HH:mm")
  }
  Write-Host ("  " + $_.TaskName.PadRight(25) + " last-run: " + $lastRun)
}
Write-Host ""
Write-Host "Log check: Get-Content $logDir\weekly_update.log -Tail 50"
Read-Host "Press Enter to close"
