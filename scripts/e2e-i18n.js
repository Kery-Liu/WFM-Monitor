'use strict';

/**
 * 英文界面回归闸门
 * 用真实 Electron 跑一遍空状态 / 新建 / 删除确认 / 各标签页，扫描 DOM 里是否还残留中文。
 * 用法：node scripts/e2e-i18n.js
 * 退出码 0 = 通过（没有漏翻）
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electron = require('electron'); // 普通 Node 下返回可执行文件路径
const dataDir = path.join(root, '_tmp', 'e2e-i18n');
const shot = path.join(root, '_tmp', 'e2e-i18n.png');
const evalFile = path.join(__dirname, 'e2e-i18n.eval.js');

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join(root, 'assets', 'catalog.seed.json'), path.join(dataDir, 'catalog.json'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const res = spawnSync(
  electron,
  [
    '.',
    `--user-data-dir=${dataDir}`,
    `--screenshot=${shot}`,
    '--screenshot-wait=3000',
    `--screenshot-eval-file=${evalFile}`,
    '--disable-gpu',
    '--no-sandbox',
  ],
  { cwd: root, env, encoding: 'utf8', timeout: 240000 }
);

const stdout = `${res.stdout || ''}`;
const line = stdout.split('\n').find((l) => l.includes('EVAL RESULT:'));
if (!line) {
  console.error('未拿到评估结果，Electron 输出：');
  console.error(stdout.slice(-2000));
  console.error(`${res.stderr || ''}`.slice(-2000));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(line.slice(line.indexOf('EVAL RESULT:') + 'EVAL RESULT:'.length).trim());
} catch (e) {
  console.error('结果解析失败：', line.slice(0, 500));
  process.exit(1);
}

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

console.log('\n— 行为断言 —');
(data.checks || []).forEach(([name, ok]) => check(name, ok));
if (data.dialogText) console.log(`  删除确认框文案: ${data.dialogText}`);

console.log('\n— 残留中文扫描 —');
let leftover = 0;
for (const [screen, list] of Object.entries(data.screens || {})) {
  const isZhControl = screen === 'zh-empty';
  if (isZhControl) continue;
  if (list.length) {
    leftover += list.length;
    console.log(`✗ ${screen} 残留 ${list.length} 条：`);
    list.slice(0, 12).forEach((t) => console.log(`    · ${t}`));
  } else {
    console.log(`✓ ${screen} 无残留`);
  }
}
check('英文模式下零中文残留', leftover === 0, `共 ${leftover} 条`);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ 英文界面通过' : `\n❌ ${failures} 项失败`);
process.exit(failures ? 1 : 0);
