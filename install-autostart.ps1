# Codex Retry Watchdog - one-shot autostart installer
# 1) Register codex-watchdog:// protocol (optional manual entry point;
#    the userscript only probes /ping and will NOT launch anything itself)
# 2) Register logon scheduled task (watchdog runs in background after login)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogJs = Join-Path $dir "codex-retry-watchdog.mjs"
$startCmd   = Join-Path $dir "start-retry-watchdog.cmd"
$taskName   = "CodexRetryWatchdog"

if (!(Test-Path $watchdogJs)) { throw "missing $watchdogJs" }
if (!(Test-Path $startCmd))   { throw "missing $startCmd" }

# ---- 1) custom protocol codex-watchdog:// ----
$protoKey = "HKCU:\Software\Classes\codex-watchdog"
New-Item -Path $protoKey -Force | Out-Null
Set-ItemProperty -Path $protoKey -Name "(default)" -Value "URL:Codex Retry Watchdog"
Set-ItemProperty -Path $protoKey -Name "URL Protocol" -Value ""
New-Item -Path "$protoKey\shell\open\command" -Force | Out-Null
$cmdLine = '"' + $startCmd + '" %1'
Set-ItemProperty -Path "$protoKey\shell\open\command" -Name "(default)" -Value $cmdLine
Write-Host "Registered protocol codex-watchdog:// -> $cmdLine"

# ---- 2) logon task ----
schtasks /Create /TN $taskName /TR ('"' + $startCmd + '"') /SC ONLOGON /RL LIMITED /F | Out-Null
Write-Host "Created logon task: $taskName"

# ---- 3) start once now ----
Start-Process -FilePath $startCmd -WindowStyle Minimized
Write-Host "Watchdog launched (minimized)"
Write-Host "Verify: http://127.0.0.1:57328/ping"
