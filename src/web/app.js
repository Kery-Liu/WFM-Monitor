'use strict';

/* global window, document, AudioContext */

const api = window.wfm;
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const S = {
  targets: [],
  selectedId: null,
  settings: null,
  events: [],
  status: null,
  tab: 'detail',
  attrs: [],
  statsCache: new Map(),
  statsLoading: new Set(),
  animKey: null, // 详情页错开入场的触发标记：只在切换监控对象时播放一次
  unread: 0,
  modal: null,
  lang: 'zh',
  theme: 'auto',
  effectiveTheme: 'dark',
};

/** 本地占位图：物品官方缺图或图片加载失败时使用，随应用打包，不依赖网络 */
const PLACEHOLDER_ICON = 'placeholder.svg';

// ---------------- i18n / theme ----------------
const I18N = window.WFMi18nEngine || null;
const isEN = () => S.lang === 'en';

/** 物品显示名：英文界面用官方英文名，中文界面用官方中文名 */
function pickName(zh, en) {
  return isEN() ? (en || zh) : (zh || en);
}

function dn(t) {
  if (!t) return '';
  return pickName(t.nameZh, t.nameEn) || t.slug || t.weaponSlug || '';
}

/** 站点根地址：英文界面用 /（官方英文站），中文界面用 /zh-hans/ */
function siteRoot() {
  return isEN() ? 'https://warframe.market' : 'https://warframe.market/zh-hans';
}

function applyI18n() {
  if (I18N) I18N.apply(document.body);
}

/** 切换界面语言：文本是渲染时生成的，必须整体重绘 */
function applyLanguage(lang, { silent = false, skipRender = false } = {}) {
  const next = lang === 'en' ? 'en' : 'zh';
  const changed = S.lang !== next;
  S.lang = next;
  if (I18N) I18N.setLang(next);
  document.documentElement.setAttribute('lang', next === 'en' ? 'en' : 'zh-CN');
  document.title = next === 'en' ? 'WFM Market Monitor' : 'WFM 价格监控';
  if (skipRender || !changed) return;
  renderAll();
  applyI18n();
  if (!silent) {
    toast('已切换语言', next === 'en' ? 'Interface switched to English' : '界面已切换为中文', 'ok', 2400);
  }
}

/** 系统主题探测：拿不到就按需求回落亮白 */
function resolveTheme(theme) {
  if (theme === 'dark' || theme === 'light') return theme;
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof mq.matches === 'boolean') return mq.matches ? 'dark' : 'light';
    }
  } catch (_) {}
  return 'light';
}

function applyTheme(theme, { skipRender = false } = {}) {
  S.theme = ['auto', 'dark', 'light'].includes(theme) ? theme : 'auto';
  S.effectiveTheme = resolveTheme(S.theme);
  document.documentElement.setAttribute('data-theme', S.effectiveTheme);
  if (!skipRender && S.tab === 'settings' && !S.settingsDirty) renderSettings();
}

// ---------------- utils ----------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const p = (n) => (n == null || Number.isNaN(n) ? '--' : `${Math.round(n * 10) / 10}p`);
const pct = (n) => (n == null ? '--' : `${(n * 100).toFixed(0)}%`);

function timeStr(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
function dateTimeStr(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function ago(ts) {
  if (!ts) return '--';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function dur(ms) {
  if (ms == null) return '--';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function sparkline(points, w, h, color) {
  const vals = (points || []).map((x) => x.p).filter((v) => typeof v === 'number');
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" style="stroke:${color}" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

const CHART_W = 800;
const CHART_H = 180;
const CHART_PAD = 6;

function bigChart(series, targetPrice, w = CHART_W, h = CHART_H) {
  if (!series || series.length < 2) {
    S.chartCtx = null;
    return '<div class="empty fill"><p>暂无 48 小时成交数据（该物品可能长期无成交）</p></div>';
  }
  const vals = series.map((s) => s.median).filter((v) => typeof v === 'number' && v > 0);
  if (vals.length < 2) {
    S.chartCtx = null;
    return '<div class="empty fill"><p>暂无有效的 48 小时成交数据</p></div>';
  }
  // Y 轴只按真实成交价缩放，目标价不参与缩放（否则目标 200p 会把 62-65p 的曲线压平）
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals);
  const spanRaw = dataMax - dataMin;
  const padPct = spanRaw > 0 ? spanRaw * 0.12 : Math.max(1, dataMax * 0.02);
  const min = Math.max(0, dataMin - padPct);
  const max = dataMax + padPct;
  const span = max - min || 1;
  const pad = CHART_PAD;
  const x = (i) => pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const d = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.median).toFixed(1)}`).join(' ');
  const area = `${d} L${x(series.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const last = series[series.length - 1];

  // 目标线：在区间内正常画，越界则贴边并用箭头标明
  let ty = null;
  let targetLabel = '';
  if (targetPrice) {
    if (targetPrice >= min && targetPrice <= max) {
      ty = y(targetPrice);
      targetLabel = `目标 ${Math.round(targetPrice)}p`;
    } else if (targetPrice > max) {
      ty = pad;
      targetLabel = `目标 ${Math.round(targetPrice)}p ↑ 高于区间`;
    } else {
      ty = h - pad;
      targetLabel = `目标 ${Math.round(targetPrice)}p ↓ 低于区间`;
    }
  }

  S.chartCtx = { series, min, max, w, h, pad };

  // 三条极淡的水平参考线：给曲线一个可读的高度参照，不抢主体颜色
  const grid = [0.25, 0.5, 0.75]
    .map((r) => `<line x1="${pad}" y1="${(pad + r * (h - pad * 2)).toFixed(1)}" x2="${w - pad}" y2="${(pad + r * (h - pad * 2)).toFixed(1)}" style="stroke:var(--line-soft)" stroke-width="1" stroke-dasharray="2 6" vector-effect="non-scaling-stroke"/>`)
    .join('');

  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--teal);stop-opacity:.26"/>
        <stop offset="100%" style="stop-color:var(--teal);stop-opacity:0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${ty != null ? `<line x1="${pad}" y1="${ty.toFixed(1)}" x2="${w - pad}" y2="${ty.toFixed(1)}" style="stroke:var(--gold)" stroke-width="1" stroke-dasharray="4 4" opacity="0.75"/>` : ''}
    <path d="${area}" fill="url(#g1)"/>
    <path d="${d}" fill="none" style="stroke:var(--teal)" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
    <line id="chart-cross" x1="0" y1="${pad}" x2="0" y2="${h - pad}" style="stroke:var(--line-strong)" stroke-width="1" stroke-dasharray="3 3" opacity="0" vector-effect="non-scaling-stroke"/>
    <circle id="chart-dot" cx="0" cy="0" r="3.5" fill="#fff" style="stroke:var(--teal)" stroke-width="2" opacity="0" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.median).toFixed(1)}" r="3" style="fill:var(--teal)"/>
    <text x="${pad}" y="12" style="fill:var(--chart-axis)" font-size="10">高 ${Math.round(dataMax)}p</text>
    <text x="${pad}" y="${h - 6}" style="fill:var(--chart-axis)" font-size="10">低 ${Math.round(dataMin)}p</text>
    ${ty != null ? `<text x="${w - pad}" y="${(ty > pad ? ty - 4 : ty + 12).toFixed(1)}" style="fill:var(--gold)" font-size="10" text-anchor="end">${esc(targetLabel)}</text>` : ''}
  </svg>
  <div class="chart-tip" id="chart-tip"></div>`;
}

/** 走势图悬停：显示该 x 位置对应的时间与白金价 */
function bindChartHover(box) {
  const ctx = S.chartCtx;
  if (!box || !ctx) return;
  const svg = box.querySelector('svg');
  const cross = box.querySelector('#chart-cross');
  const dot = box.querySelector('#chart-dot');
  const tip = box.querySelector('#chart-tip');
  if (!svg || !cross || !dot || !tip) return;
  const { series, min, max, w, h, pad } = ctx;
  const span = max - min || 1;

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (series.length - 1));
    const pt = series[idx];
    if (!pt) return;
    const vx = pad + (idx / (series.length - 1)) * (w - pad * 2);
    const vy = h - pad - ((pt.median - min) / span) * (h - pad * 2);

    cross.setAttribute('x1', vx.toFixed(1));
    cross.setAttribute('x2', vx.toFixed(1));
    cross.setAttribute('opacity', '0.55');
    dot.setAttribute('cx', vx.toFixed(1));
    dot.setAttribute('cy', vy.toFixed(1));
    dot.setAttribute('opacity', '1');

    const px = (vx / w) * rect.width;
    tip.style.opacity = '1';
    tip.style.left = `${Math.min(rect.width - 96, Math.max(6, px - 48))}px`;
    tip.innerHTML = `<b>${Math.round(pt.median)}p</b><span>${new Date(pt.t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>${pt.volume != null ? `<span>成交 ${pt.volume}</span>` : ''}`;
  };

  const leave = () => {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    tip.style.opacity = '0';
  };

  box.addEventListener('mousemove', move);
  box.addEventListener('mouseleave', leave);
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.36);
  } catch (_) {}
}

// ---------------- 游戏内私聊文案 ----------------
function whisperLang() {
  const pref = S.settings?.ui?.whisperLang || 'auto';
  if (pref === 'en' || pref === 'zh') return pref;
  return String(S.settings?.global?.language || 'zh-hans').startsWith('zh') ? 'zh' : 'en';
}

/**
 * 生成游戏内 /w 私聊文案
 * 版式对齐 warframe.market 自己的「复制」按钮：
 *   EN: /w 玩家 Hi! I want to buy: "物品 (rank 5)" for 7 platinum.
 *   ZH: /w 玩家 你好! 我想以7白金购买: "物品 (等级 5)"。
 * 紫卡拍卖额外带上紫卡名与武器名。
 */
function buildWhisper(order, t) {
  if (!order || !order.user) return '';
  const zh = whisperLang() === 'zh';
  const user = order.user.name || order.user.slug || '';
  const price = order.platinum;

  let subject;
  if (t.kind === 'auction') {
    const riven = order.rivenName || (zh ? '紫卡' : 'riven');
    const weapon = zh ? (t.nameZh || t.weaponSlug || '') : (t.nameEn || t.weaponSlug || '');
    subject = zh ? `"${riven}" ${weapon}紫卡` : `"${riven}" ${weapon} riven`;
  } else {
    let base = zh ? (t.nameZh || t.nameEn || t.slug || '') : (t.nameEn || t.nameZh || t.slug || '');
    if (order.rank != null) base += zh ? ` (等级 ${order.rank})` : ` (rank ${order.rank})`;
    subject = `"${base}"`;
  }

  const iBuy = t.kind === 'auction' ? true : order.type === 'sell';
  if (zh) {
    return iBuy
      ? `/w ${user} 你好! 我想以${price}白金购买: ${subject}。`
      : `/w ${user} 你好! 我想以${price}白金出售: ${subject}。`;
  }
  return iBuy
    ? `/w ${user} Hi! I want to buy: ${subject} for ${price} platinum.`
    : `/w ${user} Hi! I want to sell: ${subject} for ${price} platinum.`;
}

async function copyWhisper(order, t) {
  const text = buildWhisper(order, t);
  if (!text) {
    toast('无法生成', '这条挂单缺少玩家名或价格', 'err', 3000);
    return;
  }
  try {
    if (api.copyText) await api.copyText(text);
    else await navigator.clipboard.writeText(text);
    toast('已复制私聊文案', text, 'ok', 6000);
  } catch (e) {
    toast('复制失败', text, 'err', 8000);
  }
}

function toast(title, msg, type = 'ok', ms = 5200) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/** 通用三选一对话框，返回被点按钮的 value */
function askDialog({ title, message, buttons = [] }) {
  return new Promise((resolve) => {
    const root = $('#dialog-root');
    root.innerHTML = `
      <div class="modal-mask" id="dlg-mask">
        <div class="dlg">
          <div class="dlg-title">${esc(title)}</div>
          <div class="dlg-msg">${esc(message)}</div>
          <div class="dlg-btns">
            ${buttons.map((b, i) => `<button class="btn ${b.kind === 'primary' ? 'primary' : b.kind === 'danger' ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}
          </div>
        </div>
      </div>`;
    const done = (val) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done('cancel');
    };
    document.addEventListener('keydown', onKey);
    root.querySelectorAll('.dlg-btns button').forEach((btn) => {
      btn.addEventListener('click', () => done(buttons[Number(btn.dataset.i)].value));
    });
    $('#dlg-mask').addEventListener('click', (e) => {
      if (e.target.id === 'dlg-mask') done('cancel');
    });
  });
}

// ---------------- 字段说明气泡 ----------------
/**
 * 设置页/新建窗口里的灰色小字统一改成标题右侧的「!」：文字仍留在 DOM（动态文案照旧更新），
 * 只是隐藏起来，悬停时由气泡读取。气泡从图标底部中央「长」出来，不参与布局。
 */
const Tip = (() => {
  let box = null;
  let showTimer = 0;
  let hideTimer = 0;
  let current = null;

  function node() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.className = 'tip';
    box.setAttribute('role', 'tooltip');
    document.body.appendChild(box);
    return box;
  }

  /** 把说明节点的文字取出来：多段（div 子节点）按换行拼，单段折叠空白 */
  function textOf(src) {
    const blocks = Array.from(src.childNodes).filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));
    if (blocks.length > 1) return blocks.map((n) => n.textContent.trim()).filter(Boolean).join('\n');
    return src.textContent.replace(/\s+/g, ' ').trim();
  }

  function contentOf(icon) {
    return (icon.__tipSrcs || []).map(textOf).filter(Boolean).join('\n\n');
  }

  function place(icon) {
    const el = node();
    const r = icon.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = r.top - h - gap;
    const flip = top < 8;
    if (flip) top = r.bottom + gap - 4;
    el.classList.toggle('flip', flip);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function show(icon) {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
    if (current && current !== icon) hideNow();
    const text = contentOf(icon);
    if (!text) return;
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(() => {
      const el = node();
      el.textContent = text;
      el.classList.remove('show');
      el.style.visibility = 'hidden';
      place(icon); // 先量出宽高再定位
      el.style.visibility = '';
      // 强制回流一次，保证从收起状态开始播入场动画
      void el.offsetWidth;
      el.classList.add('show');
      icon.classList.add('on');
      current = icon;
    }, 100);
  }

  function hide(icon) {
    window.clearTimeout(showTimer);
    showTimer = 0;
    if (current !== icon) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (box) box.classList.remove('show');
      icon.classList.remove('on');
      current = null;
    }, 150);
  }

  function hideNow() {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    showTimer = 0;
    hideTimer = 0;
    if (box) box.classList.remove('show');
    if (current) current.classList.remove('on');
    current = null;
  }

  return { show, hide, hideNow };
})();

/** 不转成气泡的说明：版本号、快捷键状态是「状态」不是「解释」 */
const TIP_SKIP = new Set(['s-version', 's-hotkey-hint']);

function addInfoIcon(anchor, src) {
  let icon = anchor.querySelector(':scope > .info');
  if (!icon) {
    icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'info';
    icon.textContent = '!';
    icon.setAttribute('aria-label', '说明');
    icon.__tipSrcs = [];
    icon.addEventListener('mouseenter', () => Tip.show(icon));
    icon.addEventListener('mouseleave', () => Tip.hide(icon));
    icon.addEventListener('focus', () => Tip.show(icon));
    icon.addEventListener('blur', () => Tip.hide(icon));
    anchor.appendChild(icon);
  }
  if (!icon.__tipSrcs.includes(src)) icon.__tipSrcs.push(src);
}

function decorateHints(root) {
  if (!root) return;
  root.querySelectorAll('.hint').forEach((hint) => {
    if (hint.dataset.tipBound || (hint.id && TIP_SKIP.has(hint.id))) return;
    let anchor = null;
    const field = hint.closest('.field');
    if (field) anchor = field.querySelector(':scope > label:not(.switch)');
    if (!anchor) {
      // 没有归属输入框的说明：挂到最近的小节标题，再退到面板标题
      let sib = hint.previousElementSibling;
      while (sib && !sib.classList.contains('section-title')) sib = sib.previousElementSibling;
      anchor = sib;
      if (!anchor) {
        const panel = hint.closest('.panel');
        anchor = panel ? panel.querySelector('.panel-head > span:first-child') : null;
      }
    }
    if (!anchor) return;
    hint.dataset.tipBound = '1';
    addInfoIcon(anchor, hint);
  });
}

let hintQueued = false;
function initHints() {
  const roots = [$('#pane-settings'), $('#modal-root')].filter(Boolean);
  if (!roots.length) return;
  roots.forEach(decorateHints);
  // 装饰是幂等的（每个 hint 只绑一次），直接同步跑，避免 rAF 被节流时图标迟到
  const mo = new MutationObserver(() => roots.forEach(decorateHints));
  roots.forEach((r) => mo.observe(r, { childList: true, subtree: true }));
  // 滚动时气泡位置会失效，直接收掉
  document.addEventListener('scroll', () => Tip.hideNow(), true);
  window.addEventListener('resize', () => Tip.hideNow());
}

// ---------------- boot ----------------
async function boot() {
  bindGlobal();
  try {
    S.settings = await api.settings();
    S.defaults = await api.defaults().catch(() => null);
    applyLanguage(S.settings?.ui?.language || 'zh', { silent: true, skipRender: true });
    applyTheme(S.settings?.ui?.theme || 'auto', { skipRender: true });
    if (I18N) I18N.startObserver();
    if (api.hotkeyStatus) {
      api.hotkeyStatus().then((st) => {
        S.hotkeyHint = st?.registered ? `已注册：${st.accelerator}` : (st?.accelerator ? '注册失败，可能被其他程序占用' : '未启用');
      }).catch(() => {});
    }
    S.targets = await api.targets();
    S.events = await api.events(200);
    renderAll();
    applyI18n();
    if (!S.selectedId && S.targets.length) {
      S.selectedId = S.targets[0].id;
      renderTargets();
      renderDetail();
    }
    refreshStatus();
    setInterval(refreshStatus, 3000);
    setInterval(tickClocks, 1000);
    // 词条清单体积大且要等网络，放到后台加载，不阻塞首屏
    api.listAttrs().then((a) => { S.attrs = a || []; }).catch(() => {});
  } catch (e) {
    toast('初始化失败', e.message, 'err');
  }
}

function bindGlobal() {
  initHints();
  $('#tabs').addEventListener('click', async (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const next = btn.dataset.tab;
    if (!(await guardLeaveSettings(next))) return;
    switchTab(next);
  });

  $('#btn-add').addEventListener('click', async () => {
    if (!(await guardLeaveSettings('modal'))) return;
    openAddModal();
  });
  $('#btn-check-all').addEventListener('click', checkAll);
  $('#btn-pause').addEventListener('click', togglePause);

  // 设置表单改动检测
  const settingsPane = $('#pane-settings');
  if (settingsPane) {
    const onChange = (e) => {
      if (e.target.closest('input, select, textarea')) markSettingsDirty();
    };
    settingsPane.addEventListener('input', onChange);
    settingsPane.addEventListener('change', onChange);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modal) requestCloseModal();
    // 窗口内兜底通道：全局快捷键被占用或被全屏游戏拦截时，聚焦应用仍可用
    const hk = S.settings?.ui?.hotkey;
    if (!hk || !hk.enabled || !hk.accelerator || S.recordingHotkey || S.modal) return;
    if (matchesAccelerator(e, hk.accelerator)) {
      e.preventDefault();
      triggerHotkeyCheck('local');
    }
  });

  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', () => { if (S.theme === 'auto') applyTheme('auto', { skipRender: true }); });
    }
  } catch (_) {}

  $('#target-list').addEventListener('click', async (e) => {
    const toggle = e.target.closest('.card-toggle');
    if (toggle) {
      e.stopPropagation();
      const id = toggle.dataset.toggle;
      const v = S.targets.find((t) => t.id === id);
      if (!v) return;
      const next = !v.target.enabled;
      toggle.disabled = true;
      try {
        await api.updateTarget(id, { enabled: next });
        toast(next ? '已启用' : '已停用', next ? '恢复采集，不受「全部暂停」影响' : '该目标将停止采集，直到你手动启用', 'ok', 2600);
      } catch (err) {
        toast('操作失败', err.message, 'err');
      } finally {
        toggle.disabled = false;
      }
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    if (!(await guardLeaveSettings('detail'))) return;
    S.selectedId = card.dataset.id;
    switchTab('detail');
    renderTargets();
    renderDetail();
  });

  api.onPush((msg) => {
    const { type, payload } = msg;
    if (type === 'target-update') {
      const i = S.targets.findIndex((t) => t.id === payload.id);
      if (i >= 0) S.targets[i] = payload;
      else S.targets.push(payload);
      renderTargets();
      if (S.selectedId === payload.id) renderDetail();
    } else if (type === 'target-removed') {
      S.targets = S.targets.filter((t) => t.id !== payload.id);
      if (S.selectedId === payload.id) S.selectedId = null;
      renderTargets();
      renderDetail();
    } else if (type === 'trigger') {
      S.events.unshift(payload);
      if (S.tab !== 'events') S.unread += 1;
      if (S.settings?.notify?.sound?.enabled !== false) beep();
      const tv = S.targets.find((x) => x.id === payload.targetId);
      const tlabel = tv ? dn(tv.target) : payload.targetLabel;
      toast(tlabel || '监控目标达标', `当前 ${p(payload.price)}（目标 ${p(payload.targetPrice)}）`, 'ok', 8000);
      renderTabs();
      renderEvents();
    } else if (type === 'hotkey-fired') {
      triggerHotkeyCheck('global');
    } else if (type === 'hotkey-state') {
      if (payload.registered) {
        S.hotkeyHint = `已注册：${payload.accelerator}`;
      } else if (payload.accelerator) {
        S.hotkeyHint = '注册失败，可能被其他程序占用';
      } else {
        S.hotkeyHint = '未启用';
      }
      const hint = $('#s-hotkey-hint');
      if (hint) hint.textContent = S.hotkeyHint;
      if (payload.accelerator && !payload.ok) {
        toast('快捷键注册失败', `「${payload.accelerator}」可能已被其他程序占用，换一个组合试试`, 'err', 7000);
      }
    } else if (type === 'stream-state') {
      if (S.status) S.status.stream = payload;
      renderHealth();
    } else if (type === 'settings-changed') {
      S.settings = payload;
      if (S.tab === 'settings' && !S.settingsDirty) renderSettings();
      renderPauseState();
    } else if (type === 'focus-target') {
      S.selectedId = payload.targetId;
      S.tab = 'detail';
      renderTabs();
      renderTargets();
      renderDetail();
    } else if (type === 'monitor-error') {
      // 静默处理，健康面板会体现
    }
  });
}

async function refreshStatus() {
  try {
    S.status = await api.status();
    renderHealth();
    renderPauseState();
  } catch (_) {}
}

function tickClocks() {
  const el = $('#clock');
  if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  $$('[data-countdown]').forEach((n) => {
    const t = Number(n.dataset.countdown);
    n.textContent = t > 0 ? dur(t) : '即将';
    n.dataset.countdown = String(Math.max(0, t - 1000));
  });
}

// ---------------- render: shell ----------------
function renderAll() {
  renderTabs();
  renderPauseState();
  renderTargets();
  renderDetail();
  renderEvents();
  renderSettings();
  renderDiagPane();
  renderHealth();
}

function renderTabs() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  $$('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${S.tab}`));
  const badge = $('#event-badge');
  if (badge) {
    badge.textContent = S.unread > 0 ? String(S.unread) : '';
    badge.style.display = S.unread > 0 ? '' : 'none';
  }
  // 注意：这里不能重建设置页 DOM，否则会冲掉用户正在编辑的内容
}

function renderPauseState() {
  const paused = !!S.settings?.global?.paused;
  const btn = $('#btn-pause');
  if (btn) {
    btn.textContent = paused ? '恢复采集' : '全部暂停';
    btn.classList.toggle('primary', false);
    btn.title = paused ? '恢复所有已启用目标的采集' : '临时挂起所有采集，不改变各目标的启用状态';
  }
  $('#pause-chip').classList.toggle('hidden', !paused);
  const all = $('#btn-check-all');
  if (all) all.disabled = paused;
}

function renderHealth() {
  const st = S.status;
  if (!st) return;
  const http = st.http || {};
  const okDot = document.querySelector('#dot-http');
  const rate = http.successRate;
  const httpState = rate == null ? '' : rate >= 0.9 ? 'ok' : rate >= 0.6 ? 'warn' : 'bad';
  okDot.className = httpState;
  $('#txt-http').textContent = rate == null ? '—' : `${pct(rate)} · ${http.p50 || '--'}ms`;

  const wsDot = $('#dot-ws');
  const ws = st.stream || {};
  wsDot.className = ws.state === 'open' && ws.subscribed ? 'ok' : ws.state === 'connecting' ? 'warn' : ws.enabled ? 'bad' : '';
  $('#txt-ws').textContent = !ws.enabled ? '已关闭' : ws.state === 'open' ? (ws.subscribed ? '已订阅' : '连接中') : ws.state;

  const cat = st.catalog || {};
  $('#dot-cat').className = cat.ready ? 'ok' : 'warn';
  $('#txt-cat').textContent = cat.ready ? `${cat.counts.items} 项` : '加载中';
}

// ---------------- render: targets ----------------
function renderTargets() {
  const list = $('#target-list');
  $('#target-count').textContent = String(S.targets.length);
  if (!S.targets.length) {
    list.innerHTML = `<div class="empty side">
      <h3>还没有监控目标</h3>
      <p>点击上方「新建监控」，搜索任意物品（支持中文/英文/别名），设置目标价即可开始。</p>
    </div>`;
    return;
  }
  const sorted = [...S.targets].sort((a, b) => Number(b.target.enabled) - Number(a.target.enabled));
  list.innerHTML = sorted
    .map((v) => {
      const t = v.target;
      const snap = v.snapshot || {};
      const hit = snap.matched;
      const cls = ['card'];
      if (v.id === S.selectedId) cls.push('active');
      if (hit) cls.push('trigger');
      if (!t.enabled) cls.push('off');
      const color = hit ? 'var(--gold)' : 'var(--teal)';
      const name = dn(t) || '未命名';
      const sub = t.kind === 'auction'
        ? `${isEN() ? 'Riven' : '紫卡'} · ${isEN() ? (t.nameZh || t.weaponSlug) : (t.nameEn || t.weaponSlug)}`
        : (isEN() ? (t.nameZh || t.slug) : (t.nameEn || t.slug));
      return `<div class="${cls.join(' ')}" data-id="${esc(v.id)}">
        <div class="card-top">
          <div class="card-name">${esc(name)}<small>${esc(sub)}</small></div>
          <div class="card-price">
            <b class="${hit ? 'hit' : ''}">${p(snap.bestPrice)}</b>
            <span>${t.direction === 'sell' && t.kind !== 'auction' ? '≥' : '≤'} ${p(t.targetPrice)}</span>
          </div>
          <button class="card-toggle" data-toggle="${esc(v.id)}" title="${t.enabled ? '停用此监控' : '启用此监控'}">${t.enabled ? '⏸' : '▶'}</button>
        </div>
        <div class="card-meta">
          ${hit ? '<span class="pill gold">达标</span>' : ''}
          ${!t.enabled ? '<span class="pill gray">已停用</span>' : ''}
          ${t.enabled && v.state === 'error' ? `<span class="pill red">异常</span>` : ''}
          <span class="pill">${esc(t.kind === 'auction' ? '拍卖' : t.direction === 'sell' ? '收购' : '出售')}</span>
          <span class="pill ${v.failures ? 'red' : ''}">${t.intervalSec}s</span>
          ${t.enabled ? `<span class="pill gray" data-countdown="${v.nextInMs || 0}">${dur(v.nextInMs || 0)}</span>` : '<span class="pill gray">不采集</span>'}
        </div>
        ${sparkline(v.history, 300, 28, color)}
      </div>`;
    })
    .join('');
}

// ---------------- render: detail ----------------
function selectedView() {
  return S.targets.find((t) => t.id === S.selectedId) || null;
}

function renderDetail() {
  const pane = $('#pane-detail');
  const v = selectedView();
  if (!v) {
    pane.innerHTML = `<div class="empty">
      <h3>选择一个监控目标查看详情</h3>
      <p>左侧列表会实时显示每个目标的最优价、达标状态与价格走势。<br/>没有目标时，点击「＋ 新建监控」开始。</p>
    </div>`;
    return;
  }
  const t = v.target;
  const snap = v.snapshot || {};
  const name = dn(t);
  const kindLabel = t.kind === 'auction' ? '紫卡拍卖' : '市场挂单';
  const dirLabel = t.kind === 'auction'
    ? (t.auctionMode === 'bid' ? '当前竞价' : '一口价')
    : (t.direction === 'sell' ? '最高收购价' : '最低出售价');
  const statusText = { ingame: '仅游戏中', online: '游戏中+在线', all: '全部玩家' };

  const stats = [
    { label: dirLabel, value: p(snap.bestPrice), cls: snap.matched ? 'gold' : 'teal', sub: snap.bestPrice == null ? '暂无符合筛选的挂单' : `符合筛选 ${snap.totalEligible || 0} 条` },
    { label: t.kind === 'auction' ? '一口价上限' : t.direction === 'sell' ? '目标最低价' : '目标最高价', value: p(t.targetPrice), cls: '', sub: `条件 ${t.direction === 'sell' && t.kind !== 'auction' ? '≥' : '≤'} ${p(t.targetPrice)}` },
    { label: '差距', value: snap.delta == null ? '--' : p(Math.abs(snap.delta)), cls: snap.matched ? 'gold' : '', sub: snap.matched ? '已优于目标' : '距目标' },
    { label: '下次检查', value: '', valueHtml: `<b data-countdown="${v.nextInMs || 0}">${dur(v.nextInMs || 0)}</b>`, cls: '', sub: `间隔 ${t.intervalSec}s` },
  ];

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-title">
        <h2>${esc(name)}</h2>
        <div class="sub">
          <span class="pill teal">${kindLabel}</span>
          <span class="pill">${esc(statusText[t.buyerFilter] || '全部玩家')}</span>
          ${t.kind === 'auction' ? `<span class="pill">${esc(t.weaponSlug || '')}</span>` : `<span class="pill gray mono">${esc(t.slug || '')}</span>`}
          ${snap.matched ? '<span class="pill gold">● 达标中</span>' : ''}
          ${v.lastError ? `<span class="pill red">最近一次失败：${esc(v.lastError.kind || '')}</span>` : ''}
        </div>
      </div>
      <div class="row gap8">
        <label class="switch" title="${t.enabled ? '当前已启用，点击停用' : '当前已停用，点击启用'}">
          <input type="checkbox" id="tg-enabled" ${t.enabled ? 'checked' : ''}/>
          <span class="track"></span>
        </label>
        <button class="btn sm" id="btn-check">立即检查</button>
        <button class="btn sm gold" id="btn-whisper" ${snap.bestOrder ? '' : 'disabled'} title="复制发给最优卖家的游戏内私聊">复制喊话</button>
        <button class="btn sm" id="btn-edit">编辑</button>
        <button class="btn sm danger" id="btn-del">删除</button>
      </div>
    </div>

    <div class="stat-grid">
      ${stats.map((s) => `<div class="stat"><label>${s.label}</label>${s.valueHtml || `<b class="${s.cls}">${s.value}</b>`}<small>${esc(s.sub)}</small></div>`).join('')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <span>48 小时成交中位价</span>
        <span class="row gap8">
          <span class="note">${t.kind === 'auction' ? '拍卖不支持历史统计' : '来自官方 statistics 接口'}</span>
          ${t.slug ? '<button class="btn sm ghost" id="btn-load-stats">加载走势</button>' : ''}
        </span>
      </div>
      <div class="panel-body">
        <div class="chart-box" id="chart-box">${chartPlaceholder(v)}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <span>当前符合筛选的挂单（前 10）</span>
        <span class="note">最后更新 ${esc(ago(v.lastSuccessAt))}</span>
      </div>
      <div class="panel-body flush">${ordersTable(snap, t)}</div>
    </div>
  `;

  // 错开入场只在新选中的目标上播放一次：轮询重绘不重放，避免每秒闪一下
  if (S.animKey !== v.id) {
    S.animKey = v.id;
    pane.classList.remove('stagger');
    void pane.offsetWidth;
    pane.classList.add('stagger');
    setTimeout(() => pane.classList.remove('stagger'), 700);
  }

  bindDetail(v);
  bindChartHover($('#chart-box', pane));
}

function chartPlaceholder(v) {
  const cached = v.target.slug ? S.statsCache.get(v.target.slug) : null;
  if (cached) return bigChart(cached, v.target.targetPrice);
  if (!v.target.slug) return '<div class="empty fill"><p>拍卖数据无历史统计</p></div>';
  return '<div class="empty fill"><p>点击右上角「加载走势」获取 48 小时成交价曲线</p></div>';
}

function attrName(slug) {
  const a = (S.attrs || []).find((x) => x.slug === slug);
  if (!a) return slug;
  return isEN() ? (a.en || a.zh || slug) : (a.zh || a.en || slug);
}

function ordersTable(snap, t) {
  const rows = snap.top || [];
  if (!rows.length) {
    return '<div class="empty compact"><p>当前没有符合筛选条件的挂单</p></div>';
  }
  const statusText = { ingame: '游戏中', online: '在线', offline: '离线' };
  if (t.kind === 'auction') {
    return `<table class="grid">
      <thead><tr><th>价格</th><th>词条</th><th>洗练</th><th>段位</th><th>卖家</th><th>上架</th><th></th></tr></thead>
      <tbody>${rows.map((o) => `<tr>
        <td class="price num">${p(o.platinum)}</td>
        <td class="cell-sub">${(o.attributes || []).map((a) => `${a.value > 0 ? '+' : ''}${a.value}% ${esc(attrName(a.url_name))}`).join('<br/>') || '--'}</td>
        <td class="num">${o.reRolls ?? '--'}</td>
        <td class="num">${o.mastery ?? '--'}</td>
        <td><span class="status-dot ${esc(o.user.status)}"></span>${esc(o.user.name)}</td>
        <td class="note">${esc(ago(Date.parse(o.created)))}</td>
        <td><button class="btn sm ghost copy-row" data-oid="${esc(o.id)}" title="复制私聊文案">复制</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }
  return `<table class="grid">
    <thead><tr><th>价格</th><th>数量</th><th>卖家</th><th>状态</th><th>信誉</th><th>更新</th><th></th></tr></thead>
    <tbody>${rows.map((o) => `<tr>
      <td class="price num">${p(o.platinum)}</td>
      <td class="num">${o.quantity}${o.perTrade ? `<span class="muted"> /${o.perTrade}</span>` : ''}</td>
      <td>${esc(o.user.name)}</td>
      <td><span class="status-dot ${esc(o.user.status)}"></span>${esc(statusText[o.user.status] || o.user.status)}</td>
      <td class="num muted">${o.user.reputation ?? '--'}</td>
      <td class="note">${esc(ago(Date.parse(o.updatedAt)))}</td>
      <td><button class="btn sm ghost copy-row" data-oid="${esc(o.id)}" title="复制私聊文案">复制</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function bindDetail(v) {
  const pane = $('#pane-detail');
  // 用 onclick 覆盖而不是 addEventListener，避免每次重渲染后监听器叠加
  pane.onclick = (e) => {
    const btn = e.target.closest('.copy-row');
    if (!btn) return;
    const order = (v.snapshot?.top || []).find((o) => o.id === btn.dataset.oid);
    if (order) copyWhisper(order, v.target);
  };
  const enabled = $('#tg-enabled', pane);
  if (enabled) {
    enabled.addEventListener('change', async () => {
      await api.updateTarget(v.id, { enabled: enabled.checked });
      toast('已更新', enabled.checked ? '监控已启用' : '监控已停用', 'ok', 2200);
    });
  }
  const check = $('#btn-check', pane);
  if (check) check.addEventListener('click', async () => { await api.checkNow(v.id); toast('已触发检查', '稍候即可看到最新价格', 'ok', 2000); });
  const whisper = $('#btn-whisper', pane);
  if (whisper) {
    whisper.addEventListener('click', () => {
      const best = v.snapshot?.bestOrder;
      if (best) copyWhisper(best, v.target);
    });
  }
  const edit = $('#btn-edit', pane);
  if (edit) edit.addEventListener('click', () => openAddModal(v));
  const del = $('#btn-del', pane);
  if (del) {
    del.addEventListener('click', async () => {
      const okDel = await askDialog({
        title: isEN() ? 'Delete monitor' : '删除监控',
        message: isEN() ? `Delete "${v.label}"? This cannot be undone.` : `确定删除监控「${v.label}」？删除后不可撤销。`,
        buttons: [
          { label: isEN() ? 'Cancel' : '取消', value: 'cancel' },
          { label: isEN() ? 'Delete' : '删除', value: 'ok', kind: 'danger' },
        ],
      });
      if (okDel !== 'ok') return;
      await api.removeTarget(v.id);
      S.selectedId = null;
      toast('已删除', v.label, 'ok', 2200);
    });
  }
  const loadStats = $('#btn-load-stats', pane);
  if (loadStats) {
    loadStats.addEventListener('click', async () => {
      const slug = v.target.slug;
      if (!slug) return;
      loadStats.disabled = true;
      loadStats.textContent = '加载中…';
      try {
        const series = await api.itemStats(slug);
        S.statsCache.set(slug, series);
        $('#chart-box', pane).innerHTML = bigChart(series, v.target.targetPrice);
        bindChartHover($('#chart-box', pane));
        loadStats.textContent = '刷新走势';
      } catch (e) {
        toast('加载失败', e.message + (e.advice ? `\n${e.advice}` : ''), 'err');
        loadStats.textContent = '重试';
      } finally {
        loadStats.disabled = false;
      }
    });
  }
}

// ---------------- render: events ----------------
/** 事件名：优先用当前语言的目标名，历史记录里存的名字只做兜底 */
function eventName(ev) {
  const tv = (S.targets || []).find((x) => x.id === ev.targetId);
  return tv ? dn(tv.target) : (ev.targetLabel || ev.targetId);
}

/** 事件摘要按当前语言重建，避免历史记录里的整段中文在英文界面下露出 */
function eventSummary(ev) {
  const en = isEN();
  const parts = [];
  const kind = ev.kindLabel === 'auction' ? (en ? 'Riven auction' : '紫卡拍卖') : (en ? 'Market' : '市场挂单');
  const dir = ev.kindLabel === 'auction'
    ? (en ? 'buyout' : '一口价')
    : (ev.direction === 'sell' ? (en ? 'buy' : '收购') : (en ? 'sell' : '出售'));
  parts.push(`${kind} · ${dir} ${p(ev.price)} · ${en ? 'target' : '目标'} ${p(ev.targetPrice)}`);
  const seller = ev.bestOrder?.user?.name;
  if (seller) parts.push(`${en ? 'Seller' : '卖家'}: ${seller}`);
  const evTs = new Date(ev.ts).toLocaleString(en ? 'en-US' : 'zh-CN');
  parts.push(`${en ? 'Time' : '时间'}: ${evTs}`);
  return esc(parts.join(en ? '\n' : '\n'));
}
function renderEvents() {
  const pane = $('#pane-events');
  const list = S.events;
  pane.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <span>达标通知记录</span>
        <span class="row gap8">
          <span class="note">共 ${list.length} 条</span>
          <button class="btn sm ghost" id="btn-clear-events">清空</button>
        </span>
      </div>
      <div class="panel-body flush" id="event-list">
        ${list.length
          ? list.map((ev) => `<div class="event">
              <div class="event-time">${esc(dateTimeStr(ev.ts))}</div>
              <div class="event-body">
                <div class="event-title">${esc(eventName(ev))} · ${p(ev.price)}</div>
                <div class="event-msg">${eventSummary(ev)}</div>
                <div class="event-ch">
                  ${(ev.channels || []).map((c) => `<span class="pill ${c.ok ? 'green' : c.skipped ? 'gray' : 'red'}">${esc(c.channel)}${c.ok ? ' ✓' : c.skipped ? (isEN() ? ' skipped' : ' 跳过') : (isEN() ? ' failed' : ' 失败')}</span>`).join('')}
                  ${ev.suppressed ? `<span class="pill gray">${isEN() ? 'Rate-limited' : '已限流'}</span>` : ''}
                </div>
              </div>
            </div>`).join('')
          : '<div class="empty compact"><h3>暂无事件</h3><p>当某个监控目标达到你设定的价位时，记录会出现在这里。</p></div>'}
      </div>
    </div>`;
  const clear = $('#btn-clear-events');
  if (clear) {
    clear.addEventListener('click', async () => {
      const okClear = await askDialog({
        title: isEN() ? 'Clear events' : '清空事件记录',
        message: isEN() ? 'Clear all event records? This cannot be undone.' : '确定清空全部事件记录？此操作不可撤销。',
        buttons: [
          { label: isEN() ? 'Cancel' : '取消', value: 'cancel' },
          { label: isEN() ? 'Clear' : '清空', value: 'ok', kind: 'danger' },
        ],
      });
      if (okClear !== 'ok') return;
      await api.clearEvents();
      S.events = [];
      renderEvents();
    });
  }
}

// ---------------- render: diagnostics ----------------
async function renderDiagPane() {
  const pane = $('#pane-diag');
  if (!pane) return;
  if (!pane.dataset.init) {
    pane.innerHTML = `
      <div class="panel">
        <div class="panel-head"><span>网络链路自检</span>
          <span class="row gap8">
            <button class="btn sm ghost" id="btn-open-site">打开 warframe.market</button>
            <button class="btn sm primary" id="btn-run-diag">开始自检</button>
          </span>
        </div>
        <div class="panel-body" id="diag-body">
          <p class="muted m0">逐层探测：代理 → DNS → API → 订单接口 → 拍卖接口 → 实时推送 → 限速熔断。<br/>
          每一项都会说明「是否通畅」以及「不通时该怎么处理」。<br/>
          本程序只调用官方 API，不抓取网页，正常不会触发 Cloudflare 人机验证；若出现 403/验证页，多半是出口 IP 被标记，按提示处理即可。</p>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>当前运行指标</span></div>
        <div class="panel-body" id="diag-metrics"></div>
      </div>`;
    pane.dataset.init = '1';
    $('#btn-run-diag').addEventListener('click', runDiag);
    $('#btn-open-site').addEventListener('click', () => api.openExternal(siteRoot()));
  }
  renderMetrics();
}

function renderMetrics() {
  const box = $('#diag-metrics');
  if (!box || !S.status) return;
  const h = S.status.http || {};
  const s = S.status.stream || {};
  const en = isEN();
  const rows = [
    [en ? 'Total requests' : '请求总数', h.total ?? 0],
    [en ? 'Success rate' : '成功率', h.successRate == null ? '--' : pct(h.successRate)],
    [en ? 'P50 / P95 latency' : 'P50 / P95 延迟', `${h.p50 || '--'}ms / ${h.p95 || '--'}ms`],
    [en ? 'Errors' : '错误分布', Object.entries(h.byKind || {}).map(([k, v]) => `${k}×${v}`).join(en ? ', ' : '、') || (en ? 'none' : '无')],
    [en ? 'Circuit breaker' : '熔断状态', `${h.breaker?.state || '--'}${h.breaker?.reopenInSec ? ` (${h.breaker.reopenInSec}s)` : ''}`],
    [en ? 'Live stream' : '实时流', `${s.state || '--'} · ${s.events || 0} ${en ? 'events' : '事件'} · ${s.reconnects || 0} ${en ? 'reconnects' : '重连'}`],
    [en ? 'Proxy' : '代理', S.settings?.global?.proxyUrl || (en ? 'direct' : '直连')],
    [en ? 'Rate limit' : '限速', `${S.settings?.global?.minRequestIntervalMs || '--'}ms · ${en ? 'concurrency' : '并发'} ${S.settings?.global?.maxConcurrent || '--'}`],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="metric-row">
      <span class="metric-key">${esc(k)}</span><b class="metric-val">${esc(v)}</b></div>`)
    .join('');
}

async function runDiag() {
  const body = $('#diag-body');
  const btn = $('#btn-run-diag');
  btn.disabled = true;
  body.innerHTML = '<p class="muted m0">正在逐层探测…（约 5-20 秒，取决于网络）</p>';
  try {
    const r = await api.diagnose();
    body.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:6px">
        <b style="color:${r.ok ? 'var(--green)' : 'var(--amber)'}">${esc(r.summary)}</b>
        <span class="note">${esc(dateTimeStr(r.ts))}</span>
      </div>
      ${r.results.map((x) => `<div class="diag-item">
        <div class="diag-icon" style="color:${x.ok ? 'var(--green)' : 'var(--red)'}">${x.ok ? '●' : '✕'}</div>
        <div class="diag-main">
          <b>${esc(x.step)}</b>
          <p>${esc(x.detail || '')}</p>
          ${x.advice ? `<p class="advice">${esc(x.advice)}</p>` : ''}
        </div>
      </div>`).join('')}
      ${!r.ok ? `<div class="diag-actions">
        <button class="btn sm" id="btn-open-site2">打开网页手动过验证</button>
        <button class="btn sm ghost" id="btn-copy-diag">复制诊断结果</button>
      </div>` : ''}`;
    if (!r.ok) {
      $('#btn-open-site2')?.addEventListener('click', () => api.openExternal(siteRoot()));
      $('#btn-copy-diag')?.addEventListener('click', async () => {
        const text = r.results.map((x) => `${x.ok ? '[OK]' : '[FAIL]'} ${x.step}: ${x.detail}${x.advice ? ` | 建议: ${x.advice}` : ''}`).join('\n');
        try {
          await navigator.clipboard.writeText(`${r.summary}\n${text}`);
          toast('已复制', '诊断结果已写入剪贴板', 'ok', 2200);
        } catch (_) {
          toast('复制失败', '请手动选中文字复制', 'err');
        }
      });
    }
  } catch (e) {
    body.innerHTML = `<p style="color:var(--red);margin:0">自检失败：${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- render: settings ----------------
// 设置表单：所有输入都带「灰色默认值提示」；留空保存 = 回落默认值
function renderSettings() {
  const pane = $('#pane-settings');
  const cfg = S.settings;
  if (!cfg) return;
  const D = S.defaults || {};
  const g = cfg.global; const n = cfg.network; const no = cfg.notify;
  const dg = D.global || {}; const dnet = D.network || {}; const dno = D.notify || {};
  const ct = cfg.control?.email || {};
  const dw = dno.webhook || {}; const ds = dno.smtp || {}; const dq = dno.quietHours || {};
  const ph = (x) => `placeholder="${esc(x == null ? '' : String(x))}"`;
  const phText = (x) => `placeholder="${esc(x == null ? '' : String(x))}"`;

  pane.innerHTML = `
  <div class="save-bar" id="s-savebar" hidden>
    <span>● 设置有改动，尚未保存</span>
    <span class="row gap8">
      <button class="btn sm ghost" id="s-discard">放弃修改</button>
      <button class="btn sm primary" id="s-save-now">保存</button>
    </span>
  </div>

    <div class="panel">
      <div class="panel-head"><span>采集参数</span><span class="note">官方限速 3 请求/秒，低于它才安全</span></div>
      <div class="panel-body">
        <div class="form-row-3">
          <div class="field">
            <label>请求最小间隔 (ms)</label>
            <input type="number" id="s-minint" min="340" max="10000" step="10" value="${g.minRequestIntervalMs}" ${ph(dg.minRequestIntervalMs)}/>
            <div class="hint">越大越安全。默认 ${dg.minRequestIntervalMs}（≈2 req/s）</div>
          </div>
          <div class="field">
            <label>最大并发</label>
            <input type="number" id="s-maxconc" min="1" max="6" value="${g.maxConcurrent}" ${ph(dg.maxConcurrent)}/>
            <div class="hint">过高会触发 509。默认 ${dg.maxConcurrent}</div>
          </div>
          <div class="field">
            <label>默认检查间隔 (秒)</label>
            <input type="number" id="s-defint" min="15" max="3600" value="${g.defaultIntervalSec}" ${ph(dg.defaultIntervalSec)}/>
            <div class="hint">新建目标时的默认值 ${dg.defaultIntervalSec}s</div>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>平台</label>
            <select id="s-platform">
              ${['pc', 'ps4', 'xbox', 'switch', 'mobile'].map((x) => `<option value="${x}" ${g.platform === x ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>超时 (ms)</label>
            <input type="number" id="s-timeout" min="5000" max="120000" step="1000" value="${n.timeoutMs}" ${ph(dnet.timeoutMs)}/>
            <div class="hint">默认 ${dnet.timeoutMs}ms</div>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>代理地址（留空=直连）</label>
            <input type="text" id="s-proxy" placeholder="http://127.0.0.1:7890" value="${esc(g.proxyUrl || '')}"/>
            <div class="hint">支持 http/https 代理。修改后请到「网络自检」验证</div>
          </div>
          <div class="field">
            <label>实时推送</label>
            <label class="switch" style="margin-top:var(--s-2)">
              <input type="checkbox" id="s-stream" ${n.streamEnabled ? 'checked' : ''}/>
              <span class="track"></span>
              <span class="switch-label">启用 WebSocket 实时补位</span>
            </label>
            <div class="hint">断线不影响轮询，只是少了秒级提醒</div>
          </div>
        </div>
        <div class="form-row-3">
          <div class="field">
            <label>私聊文案语言</label>
            <select id="s-whisper-lang">
              <option value="auto" ${(cfg.ui?.whisperLang || 'auto') === 'auto' ? 'selected' : ''}>跟随界面语言</option>
              <option value="zh" ${cfg.ui?.whisperLang === 'zh' ? 'selected' : ''}>中文</option>
              <option value="en" ${cfg.ui?.whisperLang === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
          <div class="field">
            <label>文案预览（中）</label>
            <input type="text" value="/w 玩家 你好! 我想以100白金购买: &quot;物品 (等级 5)&quot;。" disabled/>
          </div>
          <div class="field">
            <label>文案预览（英）</label>
            <input type="text" value="/w player Hi! I want to buy: &quot;Item (rank 5)&quot; for 100 platinum." disabled/>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span>外观</span><span class="note">切换后立即生效</span></div>
      <div class="panel-body">
        <div class="form-row">
          <div class="field">
            <label>界面语言</label>
            <select id="s-ui-lang">
              <option value="zh" ${(cfg.ui?.language || 'zh') === 'zh' ? 'selected' : ''}>中文（官方中文物品名）</option>
              <option value="en" ${cfg.ui?.language === 'en' ? 'selected' : ''}>English (official English names)</option>
            </select>
            <div class="hint">切换后立即生效，物品名会跟随使用官方中文/英文名</div>
          </div>
          <div class="field">
            <label>主题</label>
            <select id="s-theme">
              <option value="auto" ${(cfg.ui?.theme || 'auto') === 'auto' ? 'selected' : ''}>跟随系统</option>
              <option value="dark" ${cfg.ui?.theme === 'dark' ? 'selected' : ''}>深黑</option>
              <option value="light" ${cfg.ui?.theme === 'light' ? 'selected' : ''}>亮白</option>
            </select>
            <div class="hint">自动跟随系统主题；系统信息不可用时使用亮白</div>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>全局快捷键（触发「全部检查」）</label>
            <div class="row gap8">
              <input type="text" id="s-hotkey-val" readonly value="${esc(cfg.ui?.hotkey?.accelerator || '')}" placeholder="点击右侧「录制」" style="flex:1;cursor:pointer"/>
              <button class="btn sm" id="s-hotkey-rec" type="button">录制</button>
              <button class="btn sm ghost" id="s-hotkey-test" type="button">测试</button>
              <button class="btn sm ghost" id="s-hotkey-clear" type="button">清除</button>
            </div>
            <div class="hint">点「录制」后按下组合键（必须含 Ctrl / Alt）；应用在后台时也能触发</div>
          </div>
          <div class="field">
            <label>快捷键开关</label>
            <div class="row gap8" style="margin-top:var(--s-2)">
              <label class="switch">
                <input type="checkbox" id="s-hotkey-on" ${cfg.ui?.hotkey?.enabled ? 'checked' : ''}/>
                <span class="track"></span>
                <span class="switch-label">启用全局快捷键</span>
              </label>
              <span class="state" id="s-hotkey-hint">${esc(S.hotkeyHint || '保存后生效，若与其他软件冲突会提示')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span>通知</span><span class="note">至少启用一个通道；灰字为默认值，留空即采用</span></div>
      <div class="panel-body">
        <div class="form-row-3">
          <div class="field">
            <label>触发冷却 (秒)</label>
            <input type="number" id="s-cooldown" min="0" max="86400" value="${no.cooldownSec}" ${ph(dno.cooldownSec)}/>
            <div class="hint">同一目标冷却期内不重复打扰 · 默认 ${dno.cooldownSec}s</div>
          </div>
          <div class="field">
            <label>再降多少才再通知 (p)</label>
            <input type="number" id="s-improve" min="0" max="100000" value="${no.improveDelta}" ${ph(dno.improveDelta)}/>
            <div class="hint">冷却期内价格更优可突破冷却 · 默认 ${dno.improveDelta}p</div>
          </div>
          <div class="field">
            <label>每小时上限</label>
            <input type="number" id="s-maxph" min="1" max="500" value="${no.maxPerHour}" ${ph(dno.maxPerHour)}/>
            <div class="hint">防止刷屏 · 默认 ${dno.maxPerHour} 条</div>
          </div>
        </div>

        <div class="field">
          <label class="switch"><input type="checkbox" id="s-desktop" ${no.desktop.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">Windows 桌面通知</span></label>
        </div>
        <div class="field">
          <label class="switch"><input type="checkbox" id="s-sound" ${no.sound.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">提示音</span></label>
        </div>

        <div class="section-title">Webhook（企业微信 / 钉钉 / 自定义）</div>
        <div class="form-row-3">
          <div class="field">
            <label>类型</label>
            <select id="s-wh-kind">
              <option value="wecom" ${no.webhook.kind === 'wecom' ? 'selected' : ''}>企业微信群机器人</option>
              <option value="dingtalk" ${no.webhook.kind === 'dingtalk' ? 'selected' : ''}>钉钉群机器人</option>
              <option value="custom" ${no.webhook.kind === 'custom' ? 'selected' : ''}>自定义 JSON</option>
            </select>
          </div>
          <div class="field span-2">
            <label>地址</label>
            <input type="text" id="s-wh-url" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value="${esc(no.webhook.url || '')}"/>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>自定义关键词（钉钉必填）</label>
            <input type="text" id="s-wh-keyword" placeholder="${esc(dw.keyword || '例如：WFM')}" value="${esc(no.webhook.keyword || '')}"/>
            <div class="hint">钉钉群机器人开启「自定义关键词」安全设置后，只有含该词的消息才会播报。填了之后，<b>每一条</b> Webhook 通知都会自动带上它。</div>
          </div>
          <div class="field">
            <label>关键词预览</label>
            <input type="text" value="${esc(no.webhook.keyword || (isEN() ? '(not set)' : '（未设置）'))} ${isEN() ? '[Hit] Ash Prime Set · 59p' : '【达标】Ash Prime 一套 · 59p'}" disabled/>
            <div class="hint">关键词会出现在标题和正文首行</div>
          </div>
        </div>
        <label class="switch" style="margin-bottom:var(--s-4)"><input type="checkbox" id="s-wh-on" ${no.webhook.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">启用 Webhook</span></label>

        <div class="section-title">邮件（SMTP）</div>
        <div class="form-row-3">
          <div class="field"><label>SMTP 服务器</label><input type="text" id="s-smtp-host" placeholder="smtp.qq.com" value="${esc(no.smtp.host || '')}"/></div>
          <div class="field"><label>端口</label><input type="number" id="s-smtp-port" value="${no.smtp.port || ''}" ${ph(ds.port)}/></div>
          <div class="field"><label>加密</label>
            <select id="s-smtp-secure">
              <option value="ssl" ${no.smtp.secure ? 'selected' : ''}>SSL (465)</option>
              <option value="starttls" ${!no.smtp.secure ? 'selected' : ''}>STARTTLS (587)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field"><label>账号（发件人）</label><input type="text" id="s-smtp-user" placeholder="you@qq.com" value="${esc(no.smtp.user || '')}"/>
          </div>
          <div class="field"><label>密码 / 授权码</label><input type="password" id="s-smtp-pass" placeholder="${no.smtp.pass ? '已保存，留空则不修改' : 'SMTP 授权码'}" value=""/></div>
        </div>
        <div class="field">
          <label>收件人</label>
          <input type="text" id="s-smtp-to" placeholder="${esc(no.smtp.user || '留空则发送到上面的账号邮箱')}" value="${esc(no.smtp.to || '')}"/>
          <div class="hint">不填就是自己发给自己；多个地址用逗号隔开</div>
        </div>
        <div class="preview-box">
          <div class="preview-title">邮件版式预览</div>
          <div class="preview-line">主题：<b>【warframe.market 达标】Ash Prime 一套 · 59p</b></div>
          <div class="preview-line">正文：物品名 + 大字当前价，下面一张表（目标价 / 当前价 / 差价 / 卖家 / 数量 / 达标挂单数 / 时间），</div>
          <div class="preview-line">底部一个「打开 warframe.market 查看」按钮和完整文本快照。</div>
        </div>
        <label class="switch" style="margin-bottom:var(--s-4)"><input type="checkbox" id="s-smtp-on" ${no.smtp.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">启用邮件通知</span></label>

        <div class="section-title">安静时段</div>
        <div class="form-row-3">
          <div class="field">
            <label class="switch"><input type="checkbox" id="s-quiet-on" ${no.quietHours.enabled ? 'checked' : ''}/><span class="track"></span><span class="switch-label">启用</span></label>
          </div>
          <div class="field"><label>开始</label><input type="text" id="s-quiet-start" ${phText(dq.start)} value="${esc(no.quietHours.start)}"/></div>
          <div class="field"><label>结束</label><input type="text" id="s-quiet-end" ${phText(dq.end)} value="${esc(no.quietHours.end)}"/></div>
        </div>
        <div class="hint" style="margin-bottom:var(--s-4)">安静时段内桌面弹窗与提示音会被抑制，但事件仍会记录、Webhook 与邮件照发。</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span>远程控制（邮件）</span><span class="note">用邮件给监控下指令</span></div>
      <div class="panel-body">
        <div class="hint" style="margin-bottom:var(--s-4)">
          <div>给邮箱发一封邮件，正文写「检查」或「check」，程序会跑一轮并把所有目标的价格汇总回给你（无达标也会回）。</div>
          <div>指令：检查 / 状态 / 帮助。</div>
        </div>
        <div class="form-row-3">
          <div class="field"><label>IMAP 服务器</label><input type="text" id="s-ctl-host" placeholder="imap.qq.com" value="${esc(ct.host || '')}"/></div>
          <div class="field"><label>端口</label><input type="number" id="s-ctl-port" value="${ct.port || ''}" placeholder="993"/></div>
          <div class="field"><label>加密</label>
            <select id="s-ctl-secure">
              <option value="ssl" ${ct.secure !== false ? 'selected' : ''}>SSL (993)</option>
              <option value="starttls" ${ct.secure === false ? 'selected' : ''}>STARTTLS (143)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field"><label>账号</label><input type="text" id="s-ctl-user" placeholder="you@qq.com" value="${esc(ct.user || '')}"/></div>
          <div class="field"><label>密码 / 授权码</label><input type="password" id="s-ctl-pass" placeholder="${ct.pass ? '已保存，留空则不修改' : 'IMAP 授权码'}" value=""/></div>
        </div>
        <div class="form-row-3">
          <div class="field"><label>收件箱</label><input type="text" id="s-ctl-mailbox" value="${esc(ct.mailbox || 'INBOX')}" placeholder="INBOX"/></div>
          <div class="field"><label>轮询间隔 (秒)</label><input type="number" id="s-ctl-poll" min="20" max="3600" value="${ct.pollSec || ''}" placeholder="60"/>
            <div class="hint">越小越实时，建议 30-120 秒</div>
          </div>
          <div class="field"><label>每分钟上限</label><input type="number" id="s-ctl-max" min="1" max="60" value="${ct.maxPer10Min || ''}" placeholder="10"/>
            <div class="hint">10 分钟内最多处理几条指令</div>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>允许的发件人（逗号分隔）</label>
            <input type="text" id="s-ctl-allow" placeholder="留空 = 只允许本账号自己发给自己" value="${esc(ct.allowFrom || '')}"/>
            <div class="hint">白名单为空时，只有本账号发出的邮件会被执行</div>
          </div>
          <div class="field">
            <label>口令（可选）</label>
            <input type="text" id="s-ctl-passphrase" placeholder="例如：wfm-9f3a" value="${esc(ct.passphrase || '')}"/>
            <div class="hint">填了之后，邮件主题或正文必须包含这串字符</div>
          </div>
        </div>
        <label class="switch" style="margin-bottom:var(--s-4)">
          <input type="checkbox" id="s-ctl-on" ${ct.enabled ? 'checked' : ''}/>
          <span class="track"></span>
          <span class="switch-label">启用邮件远程控制</span>
        </label>
        <div class="row gap8" style="flex-wrap:wrap;margin-bottom:10px">
          <button class="btn sm ghost" id="s-ctl-poll-now" type="button">立即收取一次</button>
          <span class="note" id="s-ctl-status">—</span>
        </div>
        <div class="hint">回复邮件用的是「通知 → 邮件（SMTP）」里配置的账号；没配 SMTP 就只能执行不会回复。</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span>维护</span></div>
      <div class="panel-body">
        <div class="row gap8" style="flex-wrap:wrap">
          <button class="btn primary" id="s-save">保存设置</button>
          <button class="btn ghost" id="s-test">发送测试通知</button>
          <button class="btn ghost" id="s-refresh-cat">刷新物品库</button>
          <button class="btn ghost" id="s-open-site">打开 warframe.market</button>
          <button class="btn danger" id="s-reset">恢复默认设置</button>
        </div>
        <div class="hint" style="margin-top:var(--s-4)" id="s-version"></div>
        <div class="hint" style="margin-top:var(--s-2)">「恢复默认设置」会把上面所有项（包括 Webhook 地址与邮箱账号密码）重置为初始值，请谨慎使用。</div>
      </div>
    </div>`;

  bindSettingsForm();
  updateSaveBar();
}

function bindSettingsForm() {
  $('#s-save').addEventListener('click', () => saveSettingsFromForm());
  $('#s-test').addEventListener('click', async () => {
    try {
      const r = await api.testNotify();
      const okCh = (r.results || []).filter((x) => x.ok).map((x) => x.channel);
      const bad = (r.results || []).filter((x) => x.ok === false);
      if (okCh.length) toast('已发送', isEN() ? `OK: ${okCh.join(', ')}` : `成功通道：${okCh.join('、')}`, 'ok');
      if (bad.length) toast('部分失败', bad.map((b) => `${b.channel}: ${b.error}`).join('\n'), 'err', 8000);
      if (!okCh.length && !bad.length) toast('没有可用通道', '请先启用至少一个通知通道并保存', 'err');
    } catch (e) {
      toast('测试失败', e.message, 'err');
    }
  });
  $('#s-refresh-cat').addEventListener('click', async () => {
    try {
      const meta = await api.refreshCatalog();
      toast('已刷新', isEN()
        ? `${meta.counts.items} items · ${meta.counts.weapons} weapons · ${meta.counts.attrs} stats`
        : `物品 ${meta.counts.items}｜武器 ${meta.counts.weapons}｜词条 ${meta.counts.attrs}`, 'ok');
    } catch (e) {
      toast('刷新失败', e.message + (e.advice ? `\n${e.advice}` : ''), 'err', 8000);
    }
  });
  $('#s-open-site').addEventListener('click', () => api.openExternal(siteRoot()));
  $('#s-reset').addEventListener('click', async () => {
    const ok = await askDialog({
      title: '恢复默认设置？',
      message: '将把所有设置（含 Webhook 地址与邮箱账号/授权码）重置为出厂值，此操作不可撤销。',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '确认恢复', value: 'ok', kind: 'danger' },
      ],
    });
    if (ok !== 'ok') return;
    try {
      S.settings = await api.resetSettings();
      S.settingsDirty = false;
      renderSettings();
      renderPauseState();
      toast('已恢复默认', '所有设置已重置', 'ok', 2600);
    } catch (e) {
      toast('恢复失败', e.message, 'err');
    }
  });
  const pollBtn = $('#s-ctl-poll-now');
  if (pollBtn) {
    pollBtn.addEventListener('click', async () => {
      if (!api.controlPoll) return;
      pollBtn.disabled = true;
      try {
        const r = await api.controlPoll();
        if (r && r.ok === false) toast('收取失败', r.error || '未知错误', 'err', 6000);
        else if (r && r.skipped) toast('未启用', '请先填写 IMAP 信息并启用', 'err', 4000);
        else toast('已收取', isEN() ? `${r.seen || 0} mail(s) scanned, ${r.executed || 0} command(s) executed` : `收到 ${r.seen || 0} 封，执行 ${r.executed || 0} 条指令`, 'ok', 5000);
      } catch (e) {
        toast('收取失败', e.message, 'err');
      } finally {
        pollBtn.disabled = false;
      }
    });
  }
  if (api.controlStatus) {
    api.controlStatus().then((st) => {
      const el = $('#s-ctl-status');
      if (!el || !st) return;
      const en = isEN();
      const parts = [];
      parts.push(st.enabled ? (st.available ? (en ? 'running' : '运行中') : (en ? 'dependency missing' : '依赖缺失')) : (en ? 'not enabled' : '未启用'));
      if (st.lastPollAt) parts.push((en ? 'last fetch ' : '上次收取 ') + new Date(st.lastPollAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN'));
      if (st.lastCommand) parts.push((en ? 'last command ' : '最近指令 ') + st.lastCommand.id);
      if (!st.smtpReady) parts.push(en ? 'SMTP not configured — no reply' : '未配置 SMTP，无法回信');
      el.textContent = parts.join(' · ');
    }).catch(() => {});
  }

  const recBtn = $('#s-hotkey-rec');
  if (recBtn) recBtn.addEventListener('click', startHotkeyRecord);
  const hkVal = $('#s-hotkey-val');
  if (hkVal) hkVal.addEventListener('click', startHotkeyRecord);
  const hkTest = $('#s-hotkey-test');
  if (hkTest) {
    hkTest.addEventListener('click', async () => {
      if (!api.hotkeyTest) return;
      const st = await api.hotkeyTest();
      const globalOk = st && st.registered;
      toast(
        '已通过快捷键通道触发',
        globalOk ? '全局热键已注册；若按键仍无反应，多半被其他程序抢占' : '全局热键未注册（可能被占用），当前仅窗口内可用',
        globalOk ? 'ok' : 'err',
        6000
      );
    });
  }
  const hkClear = $('#s-hotkey-clear');
  if (hkClear) {
    hkClear.addEventListener('click', () => {
      if (hkVal) hkVal.value = '';
      markSettingsDirty();
    });
  }

  const langSel = $('#s-ui-lang');
  if (langSel) {
    langSel.addEventListener('change', async () => {
      const lang = langSel.value;
      const ok = await saveSettingsFromForm();
      if (ok) applyLanguage(lang);
    });
  }
  const themeSel = $('#s-theme');
  if (themeSel) {
    themeSel.addEventListener('change', async () => {
      const theme = themeSel.value;
      const ok = await saveSettingsFromForm();
      if (ok) applyTheme(theme);
    });
  }
  $('#s-save-now').addEventListener('click', () => saveSettingsFromForm());
  $('#s-discard').addEventListener('click', () => {
    S.settingsDirty = false;
    renderSettings();
    toast('已放弃修改', '表单已还原为已保存的设置', 'ok', 2200);
  });
  api.version().then((v) => {
    const el = $('#s-version');
    if (el) el.textContent = `版本 ${v.app}｜Electron ${v.electron}｜Node ${v.node}`;
  });
}

function markSettingsDirty() {
  if (S.tab !== 'settings') return;
  if (S.settingsDirty) return;
  S.settingsDirty = true;
  updateSaveBar();
}

function updateSaveBar() {
  const bar = $('#s-savebar');
  if (bar) bar.hidden = !S.settingsDirty;
}

async function saveSettingsFromForm() {
  const numOr = (id, dflt) => {
    const el = $(id);
    if (!el) return dflt;
    const raw = String(el.value).trim();
    if (raw === '') return dflt;
    const num = Number(raw);
    return Number.isFinite(num) ? num : dflt;
  };
  const str = (id) => ($(id)?.value ?? '').trim();
  const chk = (id) => !!$(id)?.checked;
  const D = S.defaults || {};
  const dg = D.global || {}; const dnet = D.network || {}; const dno = D.notify || {};
  const dq = dno.quietHours || {}; const ds = dno.smtp || {};
  const oldPass = S.settings?.notify?.smtp?.pass || '';
  const oldCtlPass = S.settings?.control?.email?.pass || '';
  const newCtlPass = $('#s-ctl-pass')?.value || '';
  const newPass = $('#s-smtp-pass')?.value || '';

  const patch = {
    global: {
      minRequestIntervalMs: numOr('#s-minint', dg.minRequestIntervalMs ?? 500),
      maxConcurrent: numOr('#s-maxconc', dg.maxConcurrent ?? 2),
      defaultIntervalSec: numOr('#s-defint', dg.defaultIntervalSec ?? 60),
      platform: $('#s-platform')?.value || 'pc',
      proxyUrl: str('#s-proxy'),
    },
    network: {
      timeoutMs: numOr('#s-timeout', dnet.timeoutMs ?? 20000),
      streamEnabled: chk('#s-stream'),
    },
    notify: {
      cooldownSec: numOr('#s-cooldown', dno.cooldownSec ?? 600),
      improveDelta: numOr('#s-improve', dno.improveDelta ?? 5),
      maxPerHour: numOr('#s-maxph', dno.maxPerHour ?? 30),
      desktop: { enabled: chk('#s-desktop') },
      sound: { enabled: chk('#s-sound') },
      webhook: {
        enabled: chk('#s-wh-on'),
        kind: $('#s-wh-kind')?.value || 'wecom',
        url: str('#s-wh-url'),
        keyword: str('#s-wh-keyword'),
      },
      smtp: {
        enabled: chk('#s-smtp-on'),
        host: str('#s-smtp-host'),
        port: numOr('#s-smtp-port', ds.port ?? 465),
        secure: $('#s-smtp-secure')?.value !== 'starttls',
        user: str('#s-smtp-user'),
        pass: newPass || oldPass,
        to: str('#s-smtp-to'),
      },
      quietHours: {
        enabled: chk('#s-quiet-on'),
        start: str('#s-quiet-start') || dq.start || '23:30',
        end: str('#s-quiet-end') || dq.end || '08:00',
      },
    },
    control: {
      email: {
        enabled: chk('#s-ctl-on'),
        host: str('#s-ctl-host'),
        port: numOr('#s-ctl-port', 993),
        secure: $('#s-ctl-secure')?.value !== 'starttls',
        user: str('#s-ctl-user'),
        pass: newCtlPass || oldCtlPass,
        mailbox: str('#s-ctl-mailbox') || 'INBOX',
        pollSec: numOr('#s-ctl-poll', 60),
        allowFrom: str('#s-ctl-allow'),
        passphrase: str('#s-ctl-passphrase'),
        maxPer10Min: numOr('#s-ctl-max', 10),
      },
    },
    ui: {
      whisperLang: $('#s-whisper-lang')?.value || 'auto',
      language: $('#s-ui-lang')?.value || 'zh',
      theme: $('#s-theme')?.value || 'auto',
      hotkey: {
        enabled: chk('#s-hotkey-on'),
        accelerator: ($('#s-hotkey-val')?.value || '').trim(),
      },
    },
  };

  if (patch.ui.hotkey.enabled && !patch.ui.hotkey.accelerator) {
    toast('快捷键为空', '请先录制一个组合键，或关闭「启用全局快捷键」', 'err', 4200);
    return false;
  }

  try {
    S.settings = await api.saveSettings(patch);
    S.settingsDirty = false;
    renderSettings();
    renderPauseState();
    toast('已保存', '设置立即生效', 'ok', 2600);
    return true;
  } catch (e) {
    toast('保存失败', e.message, 'err');
    return false;
  }
}

/** 离开设置页前拦截未保存的修改 */
async function guardLeaveSettings(nextTab) {
  if (S.tab !== 'settings' || nextTab === 'settings' || !S.settingsDirty) return true;
  const r = await askDialog({
    title: '设置有未保存的更改',
    message: '你修改了设置但还没保存。离开前要保存吗？',
    buttons: [
      { label: '留在此页', value: 'cancel' },
      { label: '放弃修改', value: 'discard' },
      { label: '保存并离开', value: 'save', kind: 'primary' },
    ],
  });
  if (r === 'save') return saveSettingsFromForm();
  if (r === 'discard') {
    S.settingsDirty = false;
    renderSettings();
    return true;
  }
  return false;
}

function switchTab(tab) {
  S.tab = tab;
  if (tab === 'events') S.unread = 0;
  renderTabs();
  if (tab === 'settings') renderSettings();
  if (tab === 'diag') renderDiagPane();
}

async function togglePause() {
  const paused = !S.settings?.global?.paused;
  try {
    S.settings = await api.saveSettings({ global: { paused } });
    if (S.tab === 'settings') renderSettings();
    renderPauseState();
    toast(paused ? '已全部暂停' : '已恢复采集', paused ? '所有目标暂时停止取数，各自的启用状态保持不变' : '按每个目标的启用状态继续监控', 'ok', 3200);
  } catch (e) {
    toast('操作失败', e.message, 'err');
  }
}

async function checkAll() {
  if (S.settings?.global?.paused) {
    toast('已暂停', '请先点「恢复采集」，或单独对某个目标点「立即检查」', 'err', 3600);
    return;
  }
  try {
    const r = await api.checkAll();
    const skipped = r.skipped ? `，跳过 ${r.skipped} 个已停用目标` : '';
    toast('已触发', `${r.started} 个目标开始检查${skipped}`, 'ok', 2600);
  } catch (e) {
    toast('操作失败', e.message, 'err');
  }
}

// ---------------- add / edit modal ----------------
function openAddModal(existing) {
  if (!S.attrs || !S.attrs.length) {
    api.listAttrs().then((a) => {
      S.attrs = a || [];
      // 词条清单是异步来的：到位后如果紫卡表单还开着，补渲染一次（先保住已填内容）
      if (S.modal && S.modal.kind === 'auction' && $('#m-form-wrap')) {
        syncForm();
        $('#m-form-wrap').innerHTML = renderRuleForm();
        bindRuleForm();
      }
    }).catch(() => {});
  }
  const t = existing ? existing.target : null;
  S.modal = {
    existing: existing || null,
    kind: t ? t.kind : 'market',
    // 编辑时把原物品名回填到搜索框，并直接锁定为「已选」，不需要重新搜一次
    query: t ? dn(t) : '',
    results: [],
    selected: t
      ? {
          slug: t.slug || t.weaponSlug,
          id: t.itemId,
          en: t.nameEn,
          zh: t.nameZh,
          weaponSlug: t.weaponSlug,
          isExisting: true,
        }
      : null,
    form: t ? { ...t } : defaultForm('market'),
    parts: [],
    partsFor: '',
    touched: false,
    maxed: false,
    minimized: false,
    floating: false,
    pos: null,
  };
  drawModal();
  if (t) loadParts();
  else setTimeout(() => $('#m-search')?.focus(), 60);
}

/** 拉套装的散件（列表接口不返回 setParts，只能按需问详情接口） */
async function loadParts() {
  const m = S.modal;
  if (!m || !m.selected || m.kind !== 'market') return;
  const slug = m.selected.slug;
  if (!slug || !/_set$/.test(slug)) {
    m.parts = [];
    return;
  }
  if (m.partsFor === slug && m.parts.length) return;
  m.partsFor = slug;
  try {
    const d = await api.itemDetail(slug);
    if (!S.modal || S.modal !== m || m.selected?.slug !== slug) return;
    m.parts = d.parts || [];
    if (m.parts.length && $('#m-form-wrap')) {
      syncForm();
      $('#m-form-wrap').innerHTML = renderRuleForm();
      bindRuleForm();
    }
  } catch (_) {}
}

function renderPartsBlock() {
  const m = S.modal;
  if (!m || m.kind !== 'market' || !m.parts || !m.parts.length) return '';
  return `<div class="field" id="m-parts">
    <label>这套装包含以下散件（点一下即可切换监控对象）</label>
    <div class="chip-box" style="max-height:96px">
      ${m.parts.map((pt) => `<button type="button" class="pill" data-part="${esc(pt.slug)}">${esc(pickName(pt.zh, pt.en))}</button>`).join('')}
    </div>
    <div class="hint">只缺一两件时，单买散件通常比买整套便宜</div>
  </div>`;
}

function defaultForm(kind) {
  return {
    kind,
    direction: 'buy',
    targetPrice: 50,
    buyerFilter: 'ingame',
    minQuantity: 1,
    intervalSec: 60,
    confirmRounds: 1,
    auctionMode: 'buyout',
    positiveStats: [],
    negativeStats: [],
    polarity: '',
    maxReRolls: '',
    maxMastery: '',
    enabled: true,
  };
}

// ---- 快捷键：键位 -> Electron accelerator ----
function accelKeyName(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const map = {
    Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return map[code] || null;
}

function formatAccelerator(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = accelKeyName(e);
  if (!key) return { error: 'unsupported' };
  if (mods.length === 0) return { error: 'need-modifier' };
  return { value: [...mods, key].join('+') };
}

function accelToLabel(acc) {
  return String(acc || '')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/\bAlt\b/g, 'Alt')
    .replace(/\bShift\b/g, 'Shift');
}

/** 判断一次键盘事件是否匹配 accelerator */
function matchesAccelerator(e, acc) {
  if (!acc) return false;
  const parts = String(acc).split('+').map((x) => x.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  const needCtrl = parts.includes('CommandOrControl') || parts.includes('Control');
  const needAlt = parts.includes('Alt');
  const needShift = parts.includes('Shift');
  if (!!e.ctrlKey !== needCtrl) return false;
  if (!!e.altKey !== needAlt) return false;
  if (!!e.shiftKey !== needShift) return false;
  return accelKeyName(e) === key;
}

/** 快捷键触发入口：全局通道和窗口内兜底通道可能同时到，做 800ms 去重 */
function triggerHotkeyCheck(source) {
  const now = Date.now();
  if (now - (S.lastHotkeyAt || 0) < 800) return;
  S.lastHotkeyAt = now;
  S.lastHotkeySource = source;
  checkAll();
}

function startHotkeyRecord() {
  if (S.recordingHotkey) return;
  S.recordingHotkey = true;
  const input = $('#s-hotkey-val');
  const btn = $('#s-hotkey-rec');
  const origin = input ? input.value : '';
  let candidate = null;

  if (btn) {
    btn.textContent = '按下组合键…';
    btn.classList.add('primary');
  }

  const preview = (label) => {
    if (input) input.value = label;
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stop(true);
      return;
    }
    // 只看主键，修饰键单独按下不算一次输入
    const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);
    if (isModifier) {
      e.preventDefault();
      e.stopPropagation();
      const mods = [];
      if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      preview(mods.length ? `${mods.join('+')}+…` : '…');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    candidate = formatAccelerator(e);
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    preview(candidate.error ? `${mods.join('+') || '…'}+${accelKeyName(e) || '?'}` : accelToLabel(candidate.value));
  };

  const onKeyUp = (e) => {
    const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);
    if (isModifier) return; // 松开修饰键不判定，等主键松手
    if (!candidate) return;
    e.preventDefault();
    e.stopPropagation();
    const acc = candidate;
    candidate = null;
    if (acc.error) {
      toast('不支持的组合', acc.error === 'need-modifier' ? '必须包含 Ctrl 或 Alt' : '这个按键不能用作快捷键', 'err', 2800);
      stop(true); // 结束录制并还原，避免监听器挂着吞掉后续按键
      return;
    }
    if (input) input.value = acc.value;
    const on = $('#s-hotkey-on');
    if (on && !on.checked) on.checked = true; // 录好了就顺手勾上，避免"录了但不生效"
    stop(false);
    markSettingsDirty();
  };

  const stop = (canceled) => {
    S.recordingHotkey = false;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    if (btn) {
      btn.textContent = '录制';
      btn.classList.remove('primary');
    }
    if (canceled && input) input.value = origin;
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
}

// 窗口控制按钮图标：统一 10x10 画布、1px 描边，避免字符字形大小不一
function winIcon(kind) {
  const common = 'width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"';
  if (kind === 'min') return `<svg ${common} aria-hidden="true"><path d="M1 5.5h8"/></svg>`;
  if (kind === 'max') return `<svg ${common} aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7"/></svg>`;
  if (kind === 'restore') {
    return `<svg ${common} aria-hidden="true"><rect x="1.5" y="3.5" width="5" height="5"/><path d="M3.5 3.5v-2h5v5h-2"/></svg>`;
  }
  return `<svg ${common} aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>`;
}

function drawModal() {
  const m = S.modal;
  const root = $('#modal-root');
  if (S.modalCleanup) {
    S.modalCleanup();
    S.modalCleanup = null;
  }
  if (!m) {
    root.innerHTML = '';
    return;
  }
  const isAuction = m.kind === 'auction';
  const formHtml = m.selected ? renderRuleForm() : `<p class="note m0">请先在上方选择${isAuction ? '武器' : '物品'}。</p>`;
  const title = m.existing ? `编辑监控 · ${m.existing.label || ''}` : '新建监控';
  root.innerHTML = `
  <div class="modal-mask win-mask" id="m-mask">
    <div class="win ${m.maxed ? 'maxed' : ''} ${m.minimized ? 'collapsed' : ''}" id="m-box" ${m.floating ? `data-floating="1" style="left:${m.pos?.x || 80}px;top:${m.pos?.y || 60}px"` : ''}>
      <div class="win-bar" id="m-bar">
        <div class="win-title">${esc(title)}</div>
        <div class="win-ctrls">
          <button class="win-btn" id="m-min" title="${m.minimized ? '还原' : '最小化'}">${winIcon(m.minimized ? 'restore' : 'min')}</button>
          <button class="win-btn" id="m-max" title="${m.maxed ? '还原大小' : '最大化'}">${winIcon(m.maxed ? 'restore' : 'max')}</button>
          <button class="win-btn close" id="m-close" title="关闭">${winIcon('close')}</button>
        </div>
      </div>
      <div class="modal-body">
        <div class="seg" id="m-kind">
          <button data-kind="market" class="${!isAuction ? 'on' : ''}">市场挂单</button>
          <button data-kind="auction" class="${isAuction ? 'on' : ''}">紫卡拍卖</button>
        </div>

        <div class="field" style="margin-top:var(--s-4)">
          <label>${isAuction ? '搜索武器' : '搜索物品'}${m.selected ? '（重新搜索可更换）' : ''}</label>
          <input type="text" id="m-search" placeholder="${isAuction ? '例如：杀星 / kulstar / 女魔' : '例如：ash prime 一套 / 杀星 / forma'}" value="${esc(m.query)}"/>
          <div class="hint">支持中文、英文、别名：p=prime，套/set，图/bp。输入后从下方候选里点选，避免选错。</div>
        </div>
        <div class="result-list" id="m-results">${renderResults()}</div>
        <div id="m-form-wrap" style="margin-top:var(--s-5)">${formHtml}</div>
      </div>
      <div class="modal-foot">
        <span class="note" id="m-status" style="margin-right:auto"></span>
        <button class="btn" id="m-cancel">取消</button>
        <button class="btn primary" id="m-save" ${m.selected ? '' : 'disabled'}>${m.existing ? '保存修改' : '创建监控'}</button>
      </div>
    </div>
  </div>`;

  const box = $('#m-box');
  const bar = $('#m-bar');

  // 这是一个「窗口」，不是遮罩弹窗：点外面不会关闭
  $('#m-close').addEventListener('click', requestCloseModal);
  $('#m-cancel').addEventListener('click', requestCloseModal);

  $('#m-min').addEventListener('click', () => {
    if (m.selected) syncForm(); // 重建 DOM 前先保住已填内容
    m.minimized = !m.minimized;
    drawModal();
  });
  $('#m-max').addEventListener('click', () => {
    if (m.selected) syncForm();
    m.maxed = !m.maxed;
    if (m.maxed) m.floating = false;
    drawModal();
  });

  // 拖动标题栏移动窗口
  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('.win-ctrls')) return;
    if (m.maxed) return;
    const r = box.getBoundingClientRect();
    m.floating = true;
    m.pos = { x: r.left, y: r.top };
    box.dataset.floating = '1';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!drag) return;
    const w = box.offsetWidth;
    const x = Math.min(window.innerWidth - 80, Math.max(-w + 80, e.clientX - drag.dx));
    const y = Math.min(window.innerHeight - 44, Math.max(0, e.clientY - drag.dy));
    m.pos = { x, y };
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  };
  const onUp = () => {
    drag = null;
    document.body.style.userSelect = '';
  };
  bar.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // 任何输入都标记为「已改动」，关闭时提醒
  const onInput = () => { m.touched = true; };
  box.addEventListener('input', onInput);
  box.addEventListener('change', onInput);

  S.modalCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  $('#m-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b || b.dataset.kind === m.kind) return;
    m.kind = b.dataset.kind;
    m.selected = null;
    m.results = [];
    m.query = '';
    m.parts = [];
    m.partsFor = '';
    m.form = defaultForm(m.kind);
    drawModal();
  });

  const search = $('#m-search');
  let timer = null;
  search.addEventListener('input', () => {
    m.query = search.value;
    clearTimeout(timer);
    timer = setTimeout(doSearch, 220);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(timer); doSearch(); }
  });

  $('#m-results').addEventListener('click', (e) => {
    const row = e.target.closest('.result');
    if (!row || !row.dataset.idx) return;
    const c = m.results[Number(row.dataset.idx)];
    if (!c) return;
    syncForm();
    m.selected = c;
    m.results = [];
    m.parts = [];
    m.partsFor = '';
    m.query = pickName(c.zh, c.en) || c.slug;
    if (search) search.value = m.query;
    $('#m-results').innerHTML = renderResults();
    $('#m-status').textContent = `已选择：${pickName(c.zh, c.en)}`;
    $('#m-form-wrap').innerHTML = renderRuleForm();
    bindRuleForm();
    $('#m-save').disabled = false;
    loadParts();
  });

  // 官方图缺失/加载失败时换成随包占位图；占位图也失败才隐藏（error 不冒泡，用捕获阶段接）
  $('#m-results').addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const fb = img.dataset.fallback || PLACEHOLDER_ICON;
    if (img.dataset.failed !== '1') {
      img.dataset.failed = '1';
      img.src = fb;
      return;
    }
    img.classList.add('broken');
  }, true);

  if (m.selected) bindRuleForm();
  $('#m-save').addEventListener('click', submitModal);
}

function renderResults() {
  const m = S.modal;
  if (m.selected && !m.results.length) {
    const sel = m.selected;
    return `<div class="result on" style="cursor:default">
      <div class="result-main"><b>${esc(pickName(sel.zh, sel.en) || sel.slug)}</b><span>当前对象 · ${esc(sel.slug || sel.weaponSlug || '')}</span></div>
      <span class="pill gold">已选</span>
    </div>`;
  }
  if (!m.results.length) {
    return '<div class="result-empty">输入关键词开始搜索</div>';
  }
  return m.results
    .map((c, i) => {
      const on = m.selected && ((c.slug && c.slug === m.selected.slug) || (c.weaponSlug && c.weaponSlug === m.selected.weaponSlug));
      const title = pickName(c.zh, c.en);
      const sub = `${c.en || ''}${c.zh && c.en ? ' · ' : ''}${c.slug || ''}${c.tags ? ` · ${c.tags.slice(0, 3).join('/')}` : ''}${c.rivenType ? ` · ${c.rivenType}` : ''}`;
      return `<div class="result ${on ? 'on' : ''}" data-idx="${i}">
        <img src="${esc(c.thumb || PLACEHOLDER_ICON)}" data-fallback="${PLACEHOLDER_ICON}" alt=""/>
        <div class="result-main"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
        <span class="score">${Math.round(c.score || 0)}</span>
      </div>`;
    })
    .join('');
}

async function doSearch() {
  const m = S.modal;
  if (!m) return;
  const q = (m.query || '').trim();
  if (!q) {
    m.results = [];
    $('#m-results').innerHTML = renderResults();
    return;
  }
  $('#m-status').textContent = '搜索中…';
  try {
    const r = m.kind === 'auction' ? await api.searchWeapons(q) : await api.searchItems(q);
    m.results = (r.candidates || []).map((c) => ({ ...c, weaponSlug: m.kind === 'auction' ? c.slug : undefined }));
    $('#m-results').innerHTML = renderResults();
    $('#m-status').textContent = r.candidates.length
      ? `${r.candidates.length} 个候选 · 置信度 ${r.confidence}`
      : '没有匹配项，换个关键词或英文名试试';
  } catch (e) {
    $('#m-status').textContent = `搜索失败：${e.message}`;
  }
}

function renderRuleForm() {
  const m = S.modal;
  const f = m.form;
  const isAuction = m.kind === 'auction';
  const sel = m.selected;

  const common = `
    <div class="form-row-3">
      <div class="field">
        <label>目标价 (白金)</label>
        <input type="number" id="f-price" min="1" step="1" value="${f.targetPrice || 50}"/>
        <div class="hint" id="hint-price">${isAuction ? '一口价不高于此值即通知' : f.direction === 'sell' ? '收购价 ≥ 此值即通知' : '出售价 ≤ 此值即通知'}</div>
      </div>
      <div class="field">
        <label>检查间隔 (秒)</label>
        <input type="number" id="f-interval" min="10" max="3600" value="${f.intervalSec || 60}"/>
        <div class="hint">越小越快，但别低于 15s</div>
      </div>
      <div class="field">
        <label>连续确认次数</label>
        <input type="number" id="f-confirm" min="1" max="10" value="${f.confirmRounds || 1}"/>
        <div class="hint">达到 2 次才通知，可过滤瞬时挂单</div>
      </div>
    </div>
    <div class="field">
      <label>卖家范围（监督谁）</label>
      <div class="seg" id="f-buyer">
        <button data-v="ingame" class="${f.buyerFilter === 'ingame' ? 'on' : ''}">仅游戏中</button>
        <button data-v="online" class="${f.buyerFilter === 'online' ? 'on' : ''}">游戏中+在线</button>
        <button data-v="all" class="${f.buyerFilter === 'all' ? 'on' : ''}">全部玩家</button>
      </div>
      <div class="hint">「仅游戏中」最实用：状态为 ingame 的卖家能立刻交易，免去等待。</div>
    </div>`;

  if (!isAuction) {
    return `
      ${renderPartsBlock()}
      <div class="panel m0"><div class="panel-body">
        <div class="field">
          <label>我要…</label>
          <div class="seg" id="f-dir">
            <button data-v="buy" class="${f.direction !== 'sell' ? 'on' : ''}">买入（等卖单降价）</button>
            <button data-v="sell" class="${f.direction === 'sell' ? 'on' : ''}">卖出（等买单涨价）</button>
          </div>
        </div>
        ${common}
        <div class="field">
          <label>最小挂单数量</label>
          <input type="number" id="f-minqty" min="1" max="99" value="${f.minQuantity || 1}"/>
          <div class="hint">过滤掉只卖 1 个的零散单，适合按套收</div>
        </div>
        <div class="field mb0">
          <label class="switch"><input type="checkbox" id="f-enabled" ${f.enabled !== false ? 'checked' : ''}/><span class="track"></span><span class="switch-label">创建后立即启用</span></label>
        </div>
      </div></div>`;
  }

  const attrs = (S.attrs || []).filter((a) => {
    if (!a) return false;
    if (a.negativeOnly) return false;
    const rt = sel?.rivenType;
    if (rt && a.exclusiveTo?.length && !a.exclusiveTo.includes(rt)) return false;
    return true;
  });
  const negAttrs = (S.attrs || []).filter((a) => {
    if (!a) return false;
    if (a.positiveOnly) return false;
    const rt = sel?.rivenType;
    if (rt && a.exclusiveTo?.length && !a.exclusiveTo.includes(rt)) return false;
    return true;
  });
  const chip = (a, group) => {
    const on = (f[group] || []).includes(a.slug);
    return `<button type="button" class="pill ${on ? 'gold' : ''}" data-group="${group}" data-slug="${esc(a.slug)}" >${esc(pickName(a.zh, a.en))}</button>`;
  };

  return `
    <div class="panel m0"><div class="panel-body">
      <div class="form-row">
        <div class="field">
          <label>武器</label>
          <input type="text" value="${esc(pickName(sel.zh, sel.en))}（${esc(sel.slug)}）" disabled/>
        </div>
        <div class="field">
          <label>计价方式</label>
          <div class="seg" id="f-aucmode">
            <button data-v="buyout" class="${f.auctionMode !== 'bid' ? 'on' : ''}">一口价</button>
            <button data-v="bid" class="${f.auctionMode === 'bid' ? 'on' : ''}">当前竞价</button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>必须包含的正面词条（可多选，全都要满足）</label>
        <div class="chip-box" style="max-height:112px" id="f-pos">
          ${attrs.map((a) => chip(a, 'positiveStats')).join('') || '<span class="muted">无可用词条</span>'}
        </div>
      </div>
      <div class="field">
        <label>必须包含的负面词条（任选其一满足即可）</label>
        <div class="chip-box" style="max-height:96px" id="f-neg">
          ${negAttrs.map((a) => chip(a, 'negativeStats')).join('') || '<span class="muted">无可用词条</span>'}
        </div>
      </div>

      <div class="form-row-3">
        <div class="field">
          <label>极性</label>
          <select id="f-polarity">
            <option value="">不限</option>
            ${['madurai', 'vazarin', 'naramon', 'zenurik', 'umbra', 'penjaga', 'unairu'].map((x) => `<option value="${x}" ${f.polarity === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>洗练次数上限</label><input type="number" id="f-rerolls" min="0" value="${f.maxReRolls ?? ''}" placeholder="不限"/></div>
        <div class="field"><label>段位要求上限</label><input type="number" id="f-mastery" min="0" value="${f.maxMastery ?? ''}" placeholder="不限"/></div>
      </div>

      ${common}
      <div class="field mb0">
        <label class="switch"><input type="checkbox" id="f-enabled" ${f.enabled !== false ? 'checked' : ''}/><span class="track"></span><span class="switch-label">创建后立即启用</span></label>
      </div>
    </div></div>`;
}

function bindRuleForm() {
  const m = S.modal;
  if (!m) return;
  const f = m.form;

  // 切换分段控件只改状态与样式，绝不重建表单 —— 重建会丢掉用户已填的数字
  const seg = (id, key, after) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      f[key] = b.dataset.v;
      $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
      if (after) after();
    });
  };
  seg('#f-dir', 'direction', () => {
    const hint = $('#hint-price');
    if (hint) hint.textContent = f.direction === 'sell' ? '收购价 ≥ 此值即通知' : '出售价 ≤ 此值即通知';
  });
  seg('#f-buyer', 'buyerFilter');
  seg('#f-aucmode', 'auctionMode');

  ['#f-pos', '#f-neg'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-slug]');
      if (!b) return;
      const group = b.dataset.group;
      const slug = b.dataset.slug;
      const arr = f[group] || [];
      const i = arr.indexOf(slug);
      if (i >= 0) arr.splice(i, 1);
      else {
        if (arr.length >= 4) { toast('最多 4 个', '词条太多会导致匹配不到结果', 'err', 2400); return; }
        arr.push(slug);
      }
      f[group] = arr;
      b.classList.toggle('gold', arr.includes(slug));
    });
  });

  // 套装散件：点一下切到该散件，已填的价格/间隔全部保留
  const partsBox = $('#m-parts');
  if (partsBox) {
    partsBox.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-part]');
      if (!b) return;
      const pt = (m.parts || []).find((x) => x.slug === b.dataset.part);
      if (!pt) return;
      syncForm();
      m.selected = { slug: pt.slug, id: pt.id, en: pt.en, zh: pt.zh, isExisting: true };
      m.query = pickName(pt.zh, pt.en);
      m.results = [];
      m.parts = [];
      m.partsFor = '';
      const search = $('#m-search');
      if (search) search.value = m.query;
      $('#m-results').innerHTML = renderResults();
      $('#m-form-wrap').innerHTML = renderRuleForm();
      bindRuleForm();
      $('#m-status').textContent = `已切换到：${pickName(pt.zh, pt.en)}`;
    });
  }
}

/** 把表单当前输入写回内存状态（任何会重建 DOM 的操作之前必须调用） */
function syncForm() {
  const m = S.modal;
  if (!m || !m.selected) return;
  const f = m.form;
  const num = (id) => {
    const el = $(id);
    if (!el) return undefined;
    const raw = el.value.trim();
    return raw === '' ? '' : Number(raw);
  };
  const set = (key, val) => { if (val !== undefined) f[key] = val; };
  set('targetPrice', num('#f-price'));
  set('intervalSec', num('#f-interval'));
  set('confirmRounds', num('#f-confirm'));
  set('minQuantity', num('#f-minqty'));
  set('maxReRolls', num('#f-rerolls'));
  set('maxMastery', num('#f-mastery'));
  const pol = $('#f-polarity');
  if (pol) f.polarity = pol.value;
  const en = $('#f-enabled');
  if (en) f.enabled = en.checked;
}

function collectForm() {
  const m = S.modal;
  if (!m || !m.selected) return null;
  syncForm();
  const f = m.form;
  const base = {
    kind: m.kind,
    targetPrice: Number(f.targetPrice) || 0,
    intervalSec: Number(f.intervalSec) || 60,
    confirmRounds: Number(f.confirmRounds) || 1,
    buyerFilter: f.buyerFilter || 'ingame',
    enabled: f.enabled !== false,
  };
  if (m.kind === 'market') {
    return {
      ...f,
      ...base,
      slug: m.selected.slug,
      itemId: m.selected.id,
      nameEn: m.selected.en,
      nameZh: m.selected.zh,
      direction: f.direction || 'buy',
      minQuantity: Number(f.minQuantity) || 1,
    };
  }
  return {
    ...f,
    ...base,
    weaponSlug: m.selected.slug || m.selected.weaponSlug,
    label: m.selected.zh || m.selected.en,
    auctionMode: f.auctionMode || 'buyout',
    positiveStats: f.positiveStats || [],
    negativeStats: f.negativeStats || [],
    polarity: f.polarity || '',
    maxReRolls: f.maxReRolls === '' || f.maxReRolls == null ? null : Number(f.maxReRolls),
    maxMastery: f.maxMastery === '' || f.maxMastery == null ? null : Number(f.maxMastery),
  };
}

async function submitModal() {
  const m = S.modal;
  if (!m || !m.selected) return;
  const btn = $('#m-save');
  btn.disabled = true;
  $('#m-status').textContent = '保存中…';
  try {
    const payload = collectForm();
    if (!payload) throw new Error('请先选择物品');
    if (!(payload.targetPrice > 0)) throw new Error('请填写大于 0 的目标价');
    if (m.existing) {
      await api.updateTarget(m.existing.id, payload);
      toast('已保存', '监控规则已更新', 'ok');
    } else {
      const t = await api.addTarget(payload);
      S.selectedId = t.id;
      S.tab = 'detail';
      toast('已创建', `${dn(t) || t.label} 开始监控`, 'ok');
    }
    closeModal();
    S.targets = await api.targets();
    renderTargets();
    renderTabs();
    renderDetail();
  } catch (e) {
    const msg = e.message + (e.advice ? `\n${e.advice}` : '');
    $('#m-status').textContent = msg;
    toast(m.existing ? '保存失败' : '创建失败', msg, 'err', 8000);
    btn.disabled = false;
  }
}

function closeModal() {
  if (S.modalCleanup) {
    S.modalCleanup();
    S.modalCleanup = null;
  }
  S.modal = null;
  $('#modal-root').innerHTML = '';
}

/** 关闭前拦截：有未保存的监控配置就确认 */
async function requestCloseModal() {
  const m = S.modal;
  if (!m) return;
  if (m.touched) {
    const r = await askDialog({
      title: '放弃这次修改？',
      message: '监控配置还没保存，关闭后填写的内容会丢失。',
      buttons: [
        { label: '继续编辑', value: 'cancel' },
        { label: '放弃并关闭', value: 'ok', kind: 'danger' },
      ],
    });
    if (r !== 'ok') return;
  }
  closeModal();
}

// ---------------- go ----------------
boot();
