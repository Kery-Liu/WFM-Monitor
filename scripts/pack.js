'use strict';

/**
 * 便携版打包脚本（不依赖 electron-builder / electron-packager，无需联网下载额外二进制）
 * 原理：把 node_modules/electron/dist 整个复制出来，再把应用代码塞进 resources/app，
 *      改名 exe 即得到可双击运行的绿色版目录。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distRoot = path.join(root, 'dist');
const outDir = path.join(distRoot, 'WFM-Monitor');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const appDir = path.join(outDir, 'resources', 'app');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(electronDist)) {
    console.error('未找到 electron，请先运行 npm install');
    process.exit(1);
  }
  console.log('清理旧产物…');
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('复制 Electron 运行时…');
  copyDir(electronDist, outDir, (s, entry) => {
    const rel = path.relative(electronDist, s).replace(/\\/g, '/');
    if (rel === 'resources/default_app.asar') return false;
    if (entry.name === 'electron.exe') return false;
    return true;
  });
  fs.copyFileSync(path.join(electronDist, 'electron.exe'), path.join(outDir, 'WFM-Monitor.exe'));

  // 精简语言包，省 ~40MB
  const localeDir = path.join(outDir, 'locales');
  const keep = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  if (fs.existsSync(localeDir)) {
    for (const f of fs.readdirSync(localeDir)) {
      if (!keep.has(f)) fs.rmSync(path.join(localeDir, f), { force: true });
    }
  }

  console.log('写入应用代码…');
  copyDir(path.join(root, 'src'), path.join(appDir, 'src'));
  copyDir(path.join(root, 'assets'), path.join(appDir, 'assets'));

  // 用 npm 解析完整生产依赖树（imapflow / mailparser 都带一串传递依赖，不能只按名字拷）
  const depDirs = listProdDeps();
  if (!depDirs.length) {
    console.error('无法解析生产依赖树，请先 npm install');
    process.exit(1);
  }
  for (const src of depDirs) {
    const rel = path.relative(root, src);
    copyDir(src, path.join(appDir, rel));
  }
  console.log(`  生产依赖 ${depDirs.length} 个`);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const appPkg = {
    name: pkg.name,
    productName: 'WFM 价格监控',
    version: pkg.version,
    description: pkg.description,
    main: 'src/main/main.js',
    author: pkg.author,
    license: pkg.license,
    dependencies: { ws: pkg.dependencies.ws, nodemailer: pkg.dependencies.nodemailer },
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');

  const readme = path.join(root, '使用说明.md');
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(outDir, '使用说明.md'));

  const size = dirSize(outDir);
  console.log(`\n完成：${outDir}`);
  console.log(`体积：${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log('双击 WFM-Monitor.exe 即可运行。');
}

/** 用 npm 列出生产依赖的绝对路径（含嵌套依赖） */
function listProdDeps() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const nm = path.join(root, 'node_modules');
    return out
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && x !== root && x.startsWith(nm) && fs.existsSync(x));
  } catch (e) {
    console.warn('  npm ls 失败，回退到按名字拷贝：', e.message);
    return ['ws', 'nodemailer', 'imapflow', 'mailparser']
      .map((d) => path.join(root, 'node_modules', d))
      .filter((p) => fs.existsSync(p));
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch (_) {}
    }
  }
  return total;
}

main();
