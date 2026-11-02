@echo off
chcp 65001 >nul
setlocal
set S=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
set P=D:\fish-handoff\scripts\sd.ps1

:menu
cls
echo ===== 大肥鱼 SD 卡交接工具 =====
echo   1  看卡的状态
echo   2  恢复 H: 盘符（卡可以在资源管理器里看）
echo   3  把整张卡挂进 WSL（推荐先试这个）
echo   4  整盘读成镜像 D:\fish-handoff\sd\sd-full.img（不动卡）
echo   5  把镜像写回卡（危险）—— 换新系统镜像烧盘也走这里
echo   Q  退出
echo.
set /p c=选择:
if /i "%c%"=="1" %S% -NoProfile -ExecutionPolicy Bypass -File "%P%" -Action status & goto pause
if /i "%c%"=="2" %S% -NoProfile -ExecutionPolicy Bypass -File "%P%" -Action letter & goto pause
if /i "%c%"=="3" %S% -NoProfile -ExecutionPolicy Bypass -File "%P%" -Action mount & goto pause
if /i "%c%"=="4" %S% -NoProfile -ExecutionPolicy Bypass -File "%P%" -Action image & goto pause
if /i "%c%"=="5" %S% -NoProfile -ExecutionPolicy Bypass -File "%P%" -Action writeback & goto pause
if /i "%c%"=="Q" exit /b 0
goto menu

:pause
echo.
echo ---- 日志 D:\fish-handoff\scripts\sd.log 末尾 ----
powershell -NoProfile -Command "Get-Content 'D:\fish-handoff\scripts\sd.log' -Tail 20 -Encoding UTF8"
echo.
pause
goto menu
