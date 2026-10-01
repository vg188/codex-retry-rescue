@echo off
rem Codex Retry Watchdog - background launcher (minimized)
start "codex-retry-watchdog" /min node "%~dp0codex-retry-watchdog.mjs" %*
