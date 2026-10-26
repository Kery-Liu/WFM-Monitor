'use strict';

/**
 * 打包后验收：确认产物里没有使用者数据，且关键文件齐全
 * 用法：npm run verify:build
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// 用法：node verify-build.js [unpackedDir]，缺省为 release/v<版本>/win-unpacked
const unpackedArg = process.argv[2];
const versioned = path.join(root, 'release', `v${pkg.version}`, 'win-unpacked');
const legacy = path.join(root, 'release', 'win-unpacked');
const unpackedDir = unpackedArg || (fs.existsSync(versioned) ? versioned : legacy);
const appDir = path.join(unpackedDir, 'resources', 'app');

const FORBIDDEN = ['settings.json', 'targets.json', 'history.json', 'runtime.json', 'events.ndjson', 'catalog.json'];
const REQUIRED = [
  'package.json',
  'src/main/main.js',
  'src/main/preload.js',
  'src/web/index.html',
  'assets/icon.png',
  'assets/catalog.seed.json',
];

if (!fs.existsSync(appDir)) {
  console.error(`未找到产物目录：${path.relative(root, appDir)}\n请先运行 npm run dist:dir 或 npm run dist`);
  process.exit(1);
}

const found = [];
let fileCount = 0;
let bytes = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else {
      fileCount += 1;
      bytes += fs.statSync(p).size;
      if (FORBIDDEN.includes(entry.name)) found.push(path.relative(appDir, p));
    }
  }
}
walk(appDir);

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(appDir, f)));
const problems = [];
if (found.length) problems.push(`产物内含运行态文件：${found.join(', ')}`);
if (missing.length) problems.push(`产物缺关键文件：${missing.join(', ')}`);

for (const f of FORBIDDEN) {
  const p = path.join(appDir, f);
  if (fs.existsSync(p)) problems.push(`产物内含 ${f}`);
}

if (problems.length) {
  console.error('[验收失败]');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('[验收通过] 产物为出厂状态');
console.log(`  目录：${path.relative(root, appDir)}`);
console.log(`  文件：${fileCount} 个，解包后 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log('  未发现 settings.json / targets.json / history.json / runtime.json / events.ndjson / catalog.json');

const installer = path.join(root, 'release', `v${pkg.version}`, `WFM-Monitor-Setup-${pkg.version}.exe`);
if (fs.existsSync(installer)) {
  const mb = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  console.log(`  安装包：release/v${pkg.version}/WFM-Monitor-Setup-${pkg.version}.exe（${mb} MB）`);
}
