'use strict';

/**
 * 一键构建 Windows 安装包：npm run dist
 *
 * 流程：出厂校验 → 准备裁剪语言包的 Electron 运行时 → 构建目录版 →
 *      rcedit 写入图标与版本信息 → 基于目录版生成 NSIS 安装包 → 产物验收
 *
 * 为什么不直接 electron-builder --win nsis：
 *   1. 复用 node_modules 里已有的 Electron，不必重新下载几百 MB；
 *   2. 只保留中英语言包，安装包更小；
 *   3. 不依赖 winCodeSign 的解压（其 darwin 符号链接在无管理员权限的 Windows 上会失败），
 *      图标与版本信息改由 rcedit 写入，效果一致。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const BUILDER = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const OUT_DIR = path.join(root, 'release');
// 每次构建用全新的暂存目录，避免「清理旧产物」触发受限环境的批量删除拦截
const STAGE_DIR = path.join(os.tmpdir(), `wfm-stage-${Date.now()}`);
const UNPACKED = path.join(STAGE_DIR, 'win-unpacked');
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`\n命令失败（退出码 ${r.status}）：${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

/** 逐文件复制（不用 fs.cpSync，兼容受限环境；与 scripts/pack.js 同一套做法） */
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

/** 复用本地 Electron，裁掉不需要的语言包，缓存到临时目录 */
function prepareRuntime() {
  const src = path.join(root, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(src, 'electron.exe'))) {
    console.error('未找到 Electron 运行时，请先 npm install');
    process.exit(1);
  }
  const version = fs.readFileSync(path.join(src, 'version'), 'utf8').trim();
  const dest = path.join(os.tmpdir(), `wfm-electron-${version}`);
  if (fs.existsSync(path.join(dest, 'electron.exe'))) {
    console.log(`复用缓存运行时：${dest}`);
    return dest;
  }
  console.log(`准备运行时 ${version} → ${dest}`);
  // 复制时就跳过不需要的语言包，而不是复制完再删
  copyDir(src, dest, (s, entry) => {
    if (path.basename(path.dirname(s)) === 'locales' && entry.isFile() && s.endsWith('.pak')) {
      return KEEP_LOCALES.has(entry.name);
    }
    return true;
  });
  return dest;
}

/** exe 图标与版本信息（rcedit 为 devDependency，无需联网下载签名工具） */
function brandExecutable() {
  const rcedit = path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  const exe = path.join(UNPACKED, 'WFM-Monitor.exe');
  if (!fs.existsSync(rcedit)) {
    console.warn('未找到 rcedit，跳过 exe 图标与版本信息（不影响功能）');
    return;
  }
  run(process.execPath, [path.join('scripts', 'make-ico.js')]);
  run(rcedit, [
    exe,
    '--set-icon', path.join('build', 'icon.ico'),
    '--set-file-version', pkg.version,
    '--set-product-version', pkg.version,
    '--set-version-string', 'ProductName', 'WFM-Monitor',
    '--set-version-string', 'FileDescription', 'WFM Market Monitor - warframe.market price watcher',
    '--set-version-string', 'CompanyName', String(pkg.author || ''),
    '--set-version-string', 'LegalCopyright', `Copyright (c) ${new Date().getFullYear()} ${pkg.author || ''}`,
    '--set-version-string', 'OriginalFilename', 'WFM-Monitor.exe',
    '--set-version-string', 'InternalName', 'wfm-monitor',
  ]);
}

step('1/6 出厂状态校验');
run(process.execPath, [path.join('scripts', 'preflight-clean.js')]);

step('2/6 准备 Electron 运行时');
const runtime = prepareRuntime();

step('3/6 构建目录版');
run(process.execPath, [
  BUILDER, '--win', 'dir',
  `--config.electronDist=${runtime}`,
  `--config.directories.output=${STAGE_DIR}`,
  '--config.win.signAndEditExecutable=false',
]);

step('4/6 写入图标与版本信息');
brandExecutable();

step('5/6 生成 NSIS 安装包');
run(process.execPath, [
  BUILDER, '--win', 'nsis',
  '--prepackaged', UNPACKED,
  '--config.win.signAndEditExecutable=false',
]);

step('6/6 产物验收');
run(process.execPath, [path.join('scripts', 'verify-build.js'), UNPACKED]);

console.log(`\n完成：release/WFM-Monitor-Setup-${pkg.version}.exe`);
