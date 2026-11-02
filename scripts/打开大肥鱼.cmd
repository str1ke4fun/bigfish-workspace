@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-fish.ps1"
if errorlevel 1 pause
timeout /t 2 >nul
