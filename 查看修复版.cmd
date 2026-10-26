@echo off
chcp 65001 >nul
title WFM 价格监控 v1.1.0 - 独立预览
cd /d "%~dp0"

rem Preview launcher: uses a separate user-data-dir so it can run
rem alongside an older packaged build (no single-instance conflict).

if not exist "node_modules\electron\dist\electron.exe" (
  echo 未找到 Electron 运行时，请先双击「启动.cmd」完成依赖安装。
  pause
  exit /b 1
)

set "PREVIEW_DIR=%APPDATA%\wfm-monitor-preview-v1.1.0"
echo 正在以独立配置启动预览版...
echo 配置目录：%PREVIEW_DIR%
echo （首次是空目标列表，可在「设置 - 维护」里看到版本号 1.1.0）
start "" "node_modules\electron\dist\electron.exe" . --user-data-dir="%PREVIEW_DIR%"
exit /b 0
