'use strict';

/**
 * 界面样式回归闸门
 * 用真实 Electron 启动应用，注入两组假目标，然后逐项断言「改了 CSS 之后功能还在」：
 * 刻度是否生效、分段控件能否切换、窗口能否最大化/还原/关闭、标签页与侧栏选择、
 * 开关翻转、走势图悬停、错开入场只播一次、深浅主题往返、英文零残留、无横向溢出。
 * 用法：node scripts/test-ui.js（或 npm run test:ui）；退出码 0 = 全通过。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electron = require('electron'); // 普通 Node 下返回 Electron 可执行文件路径
const tmpDir = path.join(root, '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const dataDir = path.join(tmpDir, 'test-ui');
const evalFile = path.join(tmpDir, 'eval-test-ui.js');

const SCRIPT = String.raw`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = Date.now();
  const ord = (base) => [1, 2, 3].map((i) => ({
    id: 'o' + i, platinum: base + i - 1, quantity: 3, perTrade: 1,
    user: { name: 'Player' + i, status: 'ingame', reputation: 10 * i },
    updatedAt: new Date(now - i * 60000).toISOString(),
  }));
  S.targets = [
    { id: 't1', label: 'A', state: 'trigger', failures: 0, nextInMs: 53000, lastSuccessAt: now - 2000, lastError: null,
      target: { id: 't1', kind: 'market', nameZh: 'A 物品', nameEn: 'Item A', slug: 'item_a', targetPrice: 200, direction: 'buy', enabled: true, intervalSec: 60, buyerFilter: 'ingame', minQuantity: 1, confirmRounds: 1 },
      snapshot: { bestPrice: 59, matched: true, delta: 141, totalEligible: 3, bestOrder: ord(59)[0], top: ord(59) },
      history: [{ p: 62 }, { p: 60 }, { p: 59 }] },
    { id: 't2', label: 'B', state: 'ok', failures: 0, nextInMs: 20000, lastSuccessAt: now - 9000, lastError: null,
      target: { id: 't2', kind: 'market', nameZh: 'B 物品', nameEn: 'Item B', slug: 'item_b', targetPrice: 15, direction: 'sell', enabled: false, intervalSec: 30, buyerFilter: 'all', minQuantity: 1, confirmRounds: 1 },
      snapshot: { bestPrice: null, matched: false, delta: null, totalEligible: 0, bestOrder: null, top: [] },
      history: [{ p: 18 }, { p: 16 }] },
  ];
  S.selectedId = 't1';
  S.statsCache.set('item_a', Array.from({ length: 20 }, (_, i) => ({ t: now - (19 - i) * 3600000, median: 60 + (i % 4), volume: 2 + (i % 3) })));
  S.tab = 'detail';
  renderAll(); applyI18n();
  await wait(120);

  const R = [];
  const ck = (name, cond, extra) => R.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });
  const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : '');
  const q = (s) => document.querySelector(s);

  // ---- 设计刻度 ----
  ck('body 等宽数字', cs(document.body, 'fontVariantNumeric').includes('tabular-nums'), cs(document.body, 'fontVariantNumeric'));
  ck('body 字号 13px', cs(document.body, 'fontSize') === '13px', cs(document.body, 'fontSize'));
  ck('卡片圆角 12px', cs(q('.card'), 'borderRadius') === '12px', cs(q('.card'), 'borderRadius'));
  ck('面板圆角 12px', cs(q('.panel'), 'borderRadius') === '12px', cs(q('.panel'), 'borderRadius'));
  ck('按钮圆角 8px', cs(q('.btn'), 'borderRadius') === '8px', cs(q('.btn'), 'borderRadius'));
  ck('分段控件圆角 8px', (() => { openAddModal(); return true; })() && cs(q('.seg'), 'borderRadius') === '8px', cs(q('.seg'), 'borderRadius'));
  ck('面板用投影替边框', cs(q('.panel'), 'borderTopWidth') === '0px' && cs(q('.panel'), 'boxShadow') !== 'none', cs(q('.panel'), 'borderTopWidth') + ' / ' + cs(q('.panel'), 'boxShadow').slice(0, 24));
  ck('卡片左内缩对齐', Math.round(q('.card').getBoundingClientRect().left) === Math.round(q('.brand-mark').getBoundingClientRect().left), q('.card').getBoundingClientRect().left + ' vs ' + q('.brand-mark').getBoundingClientRect().left);

  // ---- 分段控件交互 ----
  const m = S.modal;
  const segBtn = document.querySelectorAll('#m-kind button')[1];
  segBtn.click();
  ck('分段控件点击切换', document.querySelectorAll('#m-kind button')[1].classList.contains('on') && S.modal.kind === 'auction');
  await wait(60);
  document.querySelectorAll('#m-kind button')[0].click();
  ck('分段控件可切回', document.querySelectorAll('#m-kind button')[0].classList.contains('on') && S.modal.kind === 'market');

  // ---- 窗口控件 ----
  document.getElementById('m-max').click();
  ck('窗口最大化', document.getElementById('m-box').classList.contains('maxed'));
  document.getElementById('m-max').click();
  ck('窗口还原', !document.getElementById('m-box').classList.contains('maxed'));
  document.getElementById('m-min').click();
  ck('窗口最小化', document.getElementById('m-box').classList.contains('collapsed'));
  document.getElementById('m-min').click();
  document.getElementById('m-close').click();
  await wait(60);
  ck('窗口关闭', !document.querySelector('#modal-root .win'));
  S.modal = null;

  // ---- 标签页 ----
  document.querySelector('[data-tab="events"]').click();
  await wait(50);
  ck('切到事件页', document.getElementById('pane-events').classList.contains('active') && document.querySelector('[data-tab="events"]').classList.contains('active'));
  document.querySelector('[data-tab="settings"]').click();
  await wait(50);
  ck('切到设置页', document.getElementById('pane-settings').classList.contains('active') && document.querySelectorAll('#pane-settings input, #pane-settings select').length > 30);
  document.querySelector('[data-tab="diag"]').click();
  await wait(50);
  ck('切到自检页', document.getElementById('pane-diag').classList.contains('active') && !!document.getElementById('diag-metrics'));
  document.querySelector('[data-tab="detail"]').click();
  await wait(50);

  // ---- 侧栏选择 ----
  document.querySelectorAll('#target-list .card')[1].click();
  await wait(80);
  ck('切换监控目标', S.selectedId === 't2' && q('.detail-title h2').textContent.includes('B'));
  document.querySelectorAll('#target-list .card')[0].click();
  await wait(80);

  // ---- 开关（点击轨道 → input 状态翻转） ----
  const tg = document.getElementById('tg-enabled');
  const before = tg.checked;
  tg.closest('.switch').querySelector('.track').click();
  await wait(50);
  ck('开关点击翻转', tg.checked !== before, before + ' -> ' + tg.checked);

  // ---- 走势图悬停 ----
  const box = document.getElementById('chart-box');
  ck('走势图已渲染', !!(box && box.querySelector('svg path')));
  const svg = box && box.querySelector('svg');
  const rect = svg ? svg.getBoundingClientRect() : { left: 0, width: 0, top: 0 };
  box.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + rect.width * 0.6, clientY: rect.top + 60, bubbles: true }));
  await wait(80);
  ck('悬停出提示', document.getElementById('chart-tip').style.opacity === '1', document.getElementById('chart-tip').style.opacity);

  // ---- 错开入场：只在新选目标时播放一次 ----
  S.selectedId = 't1'; S.animKey = null; renderDetail();
  await wait(60);
  const anim1 = getComputedStyle(document.querySelector('#pane-detail .stat')).animationName;
  await wait(760);
  renderDetail(); await wait(60);
  const anim2 = getComputedStyle(document.querySelector('#pane-detail .stat')).animationName;
  ck('错开入场只播一次', anim1 === 'rise' && anim2 !== 'rise', anim1 + ' / ' + anim2);

  // ---- 主题往返 ----
  applyTheme('light', { skipRender: true });
  const lightBg = cs(document.body, 'backgroundColor');
  applyTheme('dark', { skipRender: true });
  const darkBg = cs(document.body, 'backgroundColor');
  ck('主题切换生效', lightBg !== darkBg, lightBg + ' / ' + darkBg);
  ck('浅色下拉不起白字', (() => { applyTheme('light', { skipRender: true }); const c = cs(q('.tab'), 'color'); applyTheme('dark', { skipRender: true }); return c !== 'rgb(231, 238, 247)'; })(), '');

  // ---- 语言往返 ----
  applyLanguage('en', { silent: true, skipRender: true });
  renderAll(); applyI18n();
  await wait(120);
  ck('英文标签页', document.querySelector('.tab.active').textContent.trim() === 'Detail', document.querySelector('.tab.active').textContent.trim());
  ck('英文按钮', document.getElementById('btn-add').textContent.includes('New monitor'), document.getElementById('btn-add').textContent);
  const cjk = (window.WFMi18nEngine.collectCJK() || []).filter((s) => !/物品|Item A/.test(s));
  ck('英文无漏翻', cjk.length === 0, JSON.stringify(cjk.slice(0, 6)));
  applyLanguage('zh', { silent: true, skipRender: true });
  renderAll(); applyI18n();
  await wait(120);
  ck('切回中文', document.querySelector('.tab.active').textContent.trim() === '监控详情', document.querySelector('.tab.active').textContent.trim());

  // ---- 溢出检查 ----
  const overflow = [];
  document.querySelectorAll('.sidebar *').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible') {
      overflow.push((el.className || el.tagName) + ':' + el.scrollWidth + '>' + el.clientWidth);
    }
  });
  ck('侧栏无横向溢出', overflow.length === 0, overflow.slice(0, 4).join(', '));
  ck('页面无横向滚动', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth);

  return R;
})()`;

fs.writeFileSync(evalFile, SCRIPT, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const res = spawnSync(
  electron,
  ['.', `--user-data-dir=${dataDir}`, '--screenshot=' + path.join(tmpDir, 'test-ui.png'), '--screenshot-wait=2200', `--screenshot-eval-file=${evalFile}`, '--disable-gpu', '--no-sandbox'],
  { cwd: root, env, encoding: 'utf8', timeout: 180000 }
);

const out = `${res.stdout || ''}${res.stderr || ''}`;
const line = out.split('\n').find((l) => l.includes('EVAL RESULT:'));
if (!line) {
  console.error(out.slice(-2500));
  process.exit(1);
}
const rows = JSON.parse(line.slice(line.indexOf('EVAL RESULT:') + 13).trim());
let bad = 0;
for (const r of rows) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
  if (!r.ok) bad += 1;
}
console.log(`\n${rows.length - bad}/${rows.length} passed`);
process.exit(bad ? 1 : 0);
