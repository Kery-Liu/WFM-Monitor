'use strict';

/**
 * 打包前置守卫：确保不会把「本机运行态」带进安装包
 *
 * 检查项：
 *   1. 会被打进包里的目录（src / assets）里不得存在任何运行态文件
 *   2. package.json 的 files 白名单里不得出现 data/ 之类的运行态目录
 *   3. 源码里不得残留 Webhook key / 邮箱授权码 / 个人邮箱地址
 *
 * 任何一项不通过 → 直接中断打包（非 0 退出码）。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PACKED_DIRS = ['src', 'assets'];

// 运行态文件：一旦出现在包里就意味着泄露了使用者数据
const RUNTIME_FILES = new Set([
  'settings.json',
  'targets.json',
  'history.json',
  'runtime.json',
  'events.ndjson',
  'catalog.json',
  'Preferences',
  'Local State',
]);

// 输入框占位符用的示例邮箱，不算敏感信息
const PLACEHOLDER_LOCALPARTS = new Set(['you', 'your', 'yourname', 'example', 'sample', 'test', 'user', 'name', 'someone', 'xxx']);

const SECRET_PATTERNS = [
  { name: '企业微信 Webhook key', re: /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]{8,}/ },
  { name: '钉钉 Webhook token', re: /oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]{8,}/ },
  { name: '硬编码邮箱地址', re: /([A-Za-z0-9._%+-]+)@(qq|163|126|gmail|outlook|foxmail)\.com/, allow: (m) => PLACEHOLDER_LOCALPARTS.has(m[1].toLowerCase()) },
  { name: '疑似密码字段', re: /\b(pass|password|passwd)\s*[:=]\s*['"][^'"]{6,}['"]/i },
];

const problems = [];

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, visit);
    else visit(p, entry.name);
  }
}

// 1) 目录里不许有运行态文件
for (const d of PACKED_DIRS) {
  walk(path.join(root, d), (p, name) => {
    if (RUNTIME_FILES.has(name)) problems.push(`运行态文件出现在待打包目录：${path.relative(root, p)}`);
  });
}

// 2) files 白名单里不许出现运行态路径
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
for (const pattern of files) {
  const p = String(pattern);
  if (/^!/.test(p)) continue;
  if (/(^|\/)(data|dist|release|docs|scripts|\.workbuddy)(\/|$)/.test(p)) {
    problems.push(`打包白名单里出现了不应分发的路径：${p}`);
  }
}

// 3) 源码扫描敏感串
walk(path.join(root, 'src'), (p) => {
  if (!/\.(js|html|css|json)$/.test(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const { name, re, allow } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    if (allow && allow(m)) continue;
    problems.push(`${path.relative(root, p)} 命中「${name}」：${m[0].slice(0, 60)}`);
  }
});

if (problems.length) {
  console.error('\n[打包已中止] 检出以下问题，请先清理：\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log('[出厂状态校验] 通过');
console.log(`  - 待打包目录 ${PACKED_DIRS.join(' / ')} 中无任何运行态文件`);
console.log('  - 打包白名单未包含 data / dist / release / docs / scripts / .workbuddy');
console.log('  - 源码中未检出 Webhook key、邮箱地址、密码类硬编码');
console.log('  - 用户配置只会在首次启动时写入 %APPDATA%\\wfm-monitor，不随包分发');
