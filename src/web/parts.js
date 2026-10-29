'use strict';

/**
 * 散件对比窗口的渲染层
 * 独立页面，只依赖 preload 暴露的 wfmParts（get / update / meta / copyText / openExternal）。
 * 文案跟随主窗口的语言设置，通过 parts:meta 拿。
 * 里面的 esc / ago / statusLabel 是与 app.js 同源的小工具，改动时两边一起改。
 */

(() => {
  const api = window.wfmParts;
  if (!api) return;

  const qs = new URLSearchParams(location.search);
  const slug = qs.get('slug') || '';
  const setPriceRaw = qs.get('setPrice');
  const setPrice = setPriceRaw != null && setPriceRaw !== '' ? Number(setPriceRaw) : null;
  const nameZh = qs.get('zh') || '';
  const nameEn = qs.get('en') || '';

  let lang = 'zh';
  let current = null;
  let loading = false;

  const isEN = () => lang === 'en';
  const L = (zh, en) => (isEN() ? en : zh);
  const $ = (s) => document.querySelector(s);

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ago(ts) {
    if (!Number.isFinite(ts)) return '--';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return L('刚刚', 'just now');
    if (mins < 60) return L(`${mins} 分钟前`, `${mins}m ago`);
    const h = Math.round(mins / 60);
    if (h < 24) return L(`${h} 小时前`, `${h}h ago`);
    return L(`${Math.round(h / 24)} 天前`, `${Math.round(h / 24)}d ago`);
  }

  function statusLabel(s) {
    if (s === 'ingame') return L('游戏中', 'in game');
    if (s === 'online') return L('在线', 'online');
    return L('离线', 'offline');
  }

  function toast(title, msg) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast ok';
    el.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(14px)';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  /** 骨架表：列宽按最终形态定，等数据到了不会跳 */
  function skeleton(n) {
    const rows = Array.from({ length: Math.max(3, n || 4) }, (_, i) => `
      <tr>
        <td><div class="skel-bar" style="--i:${i};width:60%"></div></td>
        <td><div class="skel-bar" style="--i:${i};width:40%"></div></td>
        <td><div class="skel-bar" style="--i:${i};width:70%"></div></td>
        <td><div class="skel-bar" style="--i:${i};width:50%"></div></td>
        <td><div class="skel-bar" style="--i:${i};width:55%"></div></td>
        <td></td>
      </tr>`).join('');
    return `<table class="grid parts-grid">
      <thead><tr>
        <th>${L('部件', 'Part')}</th><th>${L('最低价', 'Lowest')}</th>
        <th>${L('卖家', 'Seller')}</th><th>${L('状态', 'Status')}</th>
        <th>${L('更新', 'Updated')}</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function rowsHtml(data) {
    return (data.parts || []).map((p, i) => {
      const name = isEN() ? (p.en || p.zh) : (p.zh || p.en);
      if (p.error || p.bestPrice == null) {
        return `<tr class="filled">
          <td class="part-name">${esc(name)}</td>
          <td colspan="4" class="note">${L('暂无游戏中的挂单', 'no in-game listings')}</td>
          <td></td>
        </tr>`;
      }
      const o = (p.top && p.top[0]) || {};
      const u = o.user || {};
      return `<tr class="filled" style="animation-delay:${i * 20}ms">
        <td class="part-name">${esc(name)}</td>
        <td class="price num">${p.bestPrice}p</td>
        <td>${esc(u.name || '--')}</td>
        <td><span class="status-dot ${esc(u.status || 'offline')}"></span>${esc(statusLabel(u.status))}</td>
        <td class="note">${o.updatedAt ? esc(ago(Date.parse(o.updatedAt))) : '--'}</td>
        <td><button class="btn sm ghost" data-copy="${esc(p.slug)}">${L('复制', 'Copy')}</button></td>
      </tr>`;
    }).join('');
  }

  function summaryHtml(data) {
    const t = data.totals || {};
    const bits = [];
    if (t.setPrice != null) bits.push(L(`整套 ${t.setPrice}p`, `Set ${t.setPrice}p`));
    if (t.partsSum != null) bits.push(L(`散件合计 ${t.partsSum}p`, `Parts total ${t.partsSum}p`));
    if (t.diff != null) {
      const cheaper = t.diff < 0;
      bits.push(
        cheaper
          ? `<b class="teal">${L(`买散件省 ${-t.diff}p`, `Parts cheaper by ${-t.diff}p`)}</b>`
          : `<b class="gold">${L(`买整套省 ${t.diff}p`, `Set cheaper by ${t.diff}p`)}</b>`
      );
    }
    if (t.missing) bits.push(L(`缺 ${t.missing} 件数据`, `${t.missing} missing`));
    return bits.join(' · ');
  }

  function render(data) {
    current = data;
    if (data.reason === 'not-a-set') {
      $('#p-summary').textContent = '';
      $('#p-table').innerHTML = `<div class="empty compact"><p>${L('这个物品不是套装，没有散件可对比', 'This item is not a set — nothing to compare')}</p></div>`;
      $('#p-sub').textContent = '';
      return;
    }
    $('#p-summary').innerHTML = summaryHtml(data);
    $('#p-table').innerHTML = `<table class="grid parts-grid">
      <thead><tr>
        <th>${L('部件', 'Part')}</th><th>${L('最低价', 'Lowest')}</th>
        <th>${L('卖家', 'Seller')}</th><th>${L('状态', 'Status')}</th>
        <th>${L('更新', 'Updated')}</th><th></th>
      </tr></thead>
      <tbody>${rowsHtml(data)}</tbody></table>`;
    const n = (data.parts || []).length;
    $('#p-sub').textContent = L(`${n} 个部件 · 只统计游戏中的卖家`, `${n} parts · in-game sellers only`);
    const age = data.fromCache && data.ageSec != null ? data.ageSec : 0;
    $('#p-table-note').textContent = age >= 5
      ? L(`缓存于 ${age} 秒前`, `cached ${age}s ago`)
      : L('刚刚更新', 'just updated');
  }

  /** 私聊文案跟随对方语言（与主窗口 whisperLangFor 同一套判定） */
  function buildWhisper(part, order) {
    const zh = String((order.user && order.user.locale) || '').toLowerCase().startsWith('zh');
    const user = (order.user && order.user.name) || '';
    const name = zh ? (part.zh || part.en) : (part.en || part.zh);
    const price = order.platinum;
    return zh
      ? `/w ${user} 你好! 我想以${price}白金购买: "${name}"。`
      : `/w ${user} Hi! I want to buy: "${name}" for ${price} platinum.`;
  }

  async function load(force) {
    if (loading || !slug) return;
    loading = true;
    const btn = $('#p-refresh');
    btn.disabled = true;
    if (force) {
      btn.innerHTML = `<span class="spin"></span>${L('更新中…', 'Updating…')}`;
    } else {
      $('#p-table').innerHTML = skeleton(current ? (current.parts || []).length : 4);
    }
    try {
      const data = force ? await api.update(slug, { setPrice }) : await api.get(slug, { setPrice });
      render(data);
    } catch (e) {
      $('#p-table').innerHTML = `<div class="empty compact"><p>${esc(e.message || L('加载失败', 'Failed to load'))}</p></div>`;
      $('#p-sub').textContent = '';
    } finally {
      loading = false;
      btn.disabled = false;
      btn.textContent = L('更新', 'Update');
    }
  }

  async function boot() {
    let meta = {};
    try {
      meta = await api.meta();
    } catch (_) {}
    lang = meta.lang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = isEN() ? 'en' : 'zh-CN';
    document.title = L('散件对比', 'Parts compare');

    const title = isEN() ? (nameEn || nameZh) : (nameZh || nameEn);
    $('#p-title').textContent = title || slug;
    $('#p-refresh').textContent = L('更新', 'Update');
    $('#p-table-title').textContent = L('各部件最低价', 'Lowest price per part');
    $('#p-sub').textContent = L('正在请求各部件价格…', 'Fetching part prices…');

    $('#p-refresh').addEventListener('click', () => load(true));

    // 复制按钮用事件委托：表格会被整体重建
    $('#p-table').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn || !current) return;
      const part = (current.parts || []).find((p) => p.slug === btn.dataset.copy);
      const order = part && part.top && part.top[0];
      if (!part || !order) return;
      try {
        await api.copyText(buildWhisper(part, order));
        toast(L('已复制喊话', 'Whisper copied'), buildWhisper(part, order));
      } catch (err) {
        toast(L('复制失败', 'Copy failed'), err.message);
      }
    });

    await load(false);
  }

  // 首次打开就自动取数（需求：窗口一出现就开始请求）
  boot();
})();
