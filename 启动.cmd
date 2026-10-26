@echo off
chcp 65001 >nul
title WFM 价格监控
cd /d "%~dp0"

rem 单实例锁：旧版（打包的 WFM-Monitor.exe）如果还在托盘里运行，新实例会被它顶掉，
rem 表现为「双击启动后还是旧窗口、版本号还是旧的」。这里先关掉旧进程。
tasklist /FI "IMAGENAME eq WFM-Monitor.exe" /NH 2>nul | findstr /I "WFM-Monitor.exe" >nul
if not errorlevel 1 (
  echo 检测到旧版 WFM-Monitor.exe 正在运行，正在关闭...
  taskkill /IM WFM-Monitor.exe /F >nul 2>nul
  ping -n 3 127.0.0.1 >nul
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] 首次运行，正在安装依赖（约 1-2 分钟）...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  未找到 npm，请先安装 Node.js: https://nodejs.org/
    pause
    exit /b 1
  )
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
