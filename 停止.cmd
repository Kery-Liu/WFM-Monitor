@echo off
chcp 65001 >nul
taskkill /IM electron.exe /F >nul 2>nul
echo 已停止 WFM 价格监控。
timeout /t 2 >nul
