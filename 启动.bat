@echo off
cd /d "%~dp0"
start "Resume Matcher" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765/"
exit /b 0
