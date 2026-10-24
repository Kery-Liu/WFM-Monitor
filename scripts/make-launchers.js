const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const launcher = [
  '@echo off',
  'chcp 65001 >nul',
  'title WFM 价格监控',
  'cd /d "%~dp0"',
  '',
  'if not exist "node_modules\\electron\\dist\\electron.exe" (',
  '  echo [1/2] 首次运行，正在安装依赖（约 1-2 分钟）...',
  '  where npm >nul 2>nul',
  '  if errorlevel 1 (',
  '    echo.',
  '    echo  未找到 npm，请先安装 Node.js: https://nodejs.org/',
  '    pause',
  '    exit /b 1',
  '  )',
  '  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund',
  '  if errorlevel 1 (',
  '    echo.',
  '    echo  依赖安装失败，请检查网络后重试。',
  '    pause',
  '    exit /b 1',
  '  )',
  ')',
  '',
  'start "" "node_modules\\electron\\dist\\electron.exe" .',
  'exit /b 0',
  '',
].join('\r\n');

fs.writeFileSync(path.join(root, '启动.cmd'), launcher, 'utf8');

const stop = [
  '@echo off',
  'chcp 65001 >nul',
  'taskkill /IM electron.exe /F >nul 2>nul',
  'echo 已停止 WFM 价格监控。',
  'timeout /t 2 >nul',
  '',
].join('\r\n');
fs.writeFileSync(path.join(root, '停止.cmd'), stop, 'utf8');

// eslint-disable-next-line no-console
console.log('launchers written');
