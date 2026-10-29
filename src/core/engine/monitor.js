'use strict';

/**
 * 调度层 - 单个监控单元（状态机）
 * 一次 check = 取数 → 计算快照 → 判定触发 → 去重/冷却 → 通知 → 记录
 * 每个目标独占自己的状态、失败计数与退避节奏，互不拖累。
 */

const { EventEmitter } = require('events');
const { snapshotFor } = require('../domain/rules');
const { fmtDuration } = require('../util');

class Monitor extends EventEmitter {
  constructor({ target, deps }) {
    super();
    this.target = target;
    this.deps = deps;
    this.state = 'idle'; // idle | checking | ok | trigger | error | paused
    this.lastCheckAt = 0;
    this.lastSuccessAt = 0;
    this.nextRunAt = 0;
    this.failures = 0;
    this.snapshot = null;
    this.lastError = null;
    this.confirmCount = 0;
    this.lastNotifyAt = 0;
    this.lastNotifyPrice = null;
    this.notifiedAuctionIds = new Set();
    // 恢复跨重启的冷却状态，避免每次启动都把「已达标」的东西再吼一遍
    const rt = deps.store.getRuntime(target.id);
    if (rt) {
      this.lastNotifyAt = rt.lastNotifyAt || 0;
      this.lastNotifyPrice = rt.lastNotifyPrice ?? null;
      if (Array.isArray(rt.notifiedAuctionIds)) this.notifiedAuctionIds = new Set(rt.notifiedAuctionIds.slice(-200));
    }
    this.checkCount = 0;
    this.notifyCount = 0;
    this.busy = false;
    this.forceRun = false;
    this.rawCache = [];
    this.rawCacheAt = 0;
  }

  get id() {
    return this.target.id;
  }

  get intervalMs() {
    return Math.max(10, this.target.intervalSec || 60) * 1000;
  }

  get label() {
    const t = this.target;
    const zh = t.nameZh || '';
    const en = t.nameEn || '';
    const pick = this.uiLang === 'en' ? (en || zh) : (zh || en);
    return pick || t.slug || t.weaponSlug || this.id;
  }

  scheduleIn(ms) {
    this.nextRunAt = Date.now() + ms;
  }

  /** 立即执行一次（用户点「立即检查」）；force=true 表示手动意图，可越过停用与全局暂停 */
  requestNow(force = false) {
    if (force) this.forceRun = true;
    this.nextRunAt = Date.now();
    this.emit('update', this.view());
  }

  /**
   * 规则变更（改目标价 / 方向 / 筛选）后，用本地缓存订单立即重算快照
   * 只刷新展示层（最优价、差价、达标、挂单表），不触发通知 —— 改个价格不该弹窗
   * @returns {boolean} 是否真的重算了
   */
  refreshSnapshot() {
    if (!Array.isArray(this.rawCache) || !this.rawCache.length) return false;
    // 缓存太旧就交给下一轮轮询，避免拿陈旧基准算出错误的「已达标」
    if (Date.now() - this.rawCacheAt > Math.max(this.intervalMs * 3, 60000)) return false;
    this.snapshot = snapshotFor(this.target, this.rawCache);
    return true;
  }

  /**
   * 换了一个监控对象（编辑时重新选了物品/武器）：旧订单缓存和旧通知状态全部作废
   * 否则会拿上一个物品的挂单去算新目标的差价
   */
  resetForNewItem() {
    this.rawCache = [];
    this.rawCacheAt = 0;
    this.snapshot = null;
    this.lastError = null;
    this.confirmCount = 0;
    this.lastNotifyAt = 0;
    this.lastNotifyPrice = null;
    this.notifiedAuctionIds = new Set();
    try {
      this.deps.store.setRuntime(this.id, { lastNotifyAt: 0, lastNotifyPrice: null, notifiedAuctionIds: [] });
    } catch (_) {}
  }

  async tick() {
    if (this.busy) return;
    const forced = this.forceRun;
    this.forceRun = false;

    // 停用 = 用户锁定的状态，任何调度都不能越过，只有手动「立即检查」例外
    if (!this.target.enabled && !forced) {
      this.state = 'disabled';
      this.nextRunAt = 0;
      return;
    }
    // 全局暂停 = 临时挂起，不动用启用状态
    if (this.deps.config.get().global.paused && !forced) {
      this.state = 'paused';
      this.scheduleIn(2000);
      return;
    }
    this.busy = true;
    this.state = 'checking';
    this.lastCheckAt = Date.now();
    const started = Date.now();
    this.emit('update', this.view());

    try {
      const raw = await this.fetchRaw();
      this.rawCache = Array.isArray(raw) ? raw.slice(0, 3000) : [];
      this.rawCacheAt = Date.now();
      const snap = snapshotFor(this.target, raw);
      this.snapshot = snap;
      this.lastSuccessAt = Date.now();
      this.failures = 0;
      this.lastError = null;
      this.checkCount += 1;

      if (snap.bestPrice != null) {
        this.deps.store.pushHistory(this.id, { t: snap.ts, p: snap.bestPrice }, this.deps.config.get().global.historyPoints);
      }

      await this.evaluate(snap);
      this.state = snap.matched ? 'trigger' : 'ok';
      if (this.target.enabled) this.scheduleIn(this._nextDelay());
      else this.nextRunAt = 0;
    } catch (err) {
      this.failures += 1;
      this.lastError = err.toJSON ? err.toJSON() : { message: err.message, kind: 'unknown' };
      this.state = 'error';
      this.deps.logger.warn('monitor', `${this.label} 检查失败(${this.lastError.kind || 'unknown'})：${err.message}`);
      if (this.target.enabled) this.scheduleIn(this._backoffDelay());
      else this.nextRunAt = 0;
      this.emit('error', { targetId: this.id, error: this.lastError });
    } finally {
      this.busy = false;
      const dur = Date.now() - started;
      this.emit('update', this.view(dur));
    }
  }

  async fetchRaw() {
    const t = this.target;
    if (t.kind === 'auction') {
      return this.deps.auctionSource.search(t);
    }
    if (!t.slug) {
      const e = new Error('目标缺少物品标识（slug），请重新添加');
      e.code = 'INVALID_TARGET';
      throw e;
    }
    return this.deps.marketSource.fetchOrders(t.slug);
  }

  /**
   * 实时流入口：把推送来的单条订单合并进本地缓存并立即重算
   * 只在缓存还新鲜时生效，过期就交给下一轮轮询，避免用陈旧基准误判
   */
  async applyRealtime(order) {
    if (this.target.kind !== 'market') return;
    if (this.busy) return;
    if (!this.rawCache.length) return;
    if (Date.now() - this.rawCacheAt > this.intervalMs * 3) return;

    const idx = this.rawCache.findIndex((o) => o.id === order.id);
    if (idx >= 0) this.rawCache[idx] = order;
    else {
      this.rawCache.unshift(order);
      if (this.rawCache.length > 3000) this.rawCache.length = 3000;
    }
    const snap = snapshotFor(this.target, this.rawCache);
    this.snapshot = snap;
    this.emit('update', this.view());
    await this.evaluate(snap);
  }

  _nextDelay() {
    const g = this.deps.config.get().global;
    const base = this.intervalMs;
    const f = 1 + (Math.random() * 2 - 1) * ((g.jitterPct || 0) / 100);
    return Math.max(5000, Math.round(base * f));
  }

  _backoffDelay() {
    const g = this.deps.config.get().global;
    const base = this.intervalMs;
    const mult = Math.min(6, 1.5 ** this.failures);
    return Math.min(600000, Math.round(base * mult * (1 + Math.random() * 0.3)));
  }

  async evaluate(snap) {
    const cfg = this.deps.config.get().notify;
    if (!snap.matched) {
      this.confirmCount = 0;
      // 价格回落后允许下次重新通知
      if (this.lastNotifyPrice != null && snap.bestPrice != null) {
        const back = this.target.direction === 'sell' ? snap.bestPrice < this.target.targetPrice * 0.98 : snap.bestPrice > this.target.targetPrice * 1.02;
        if (back) {
          this.lastNotifyAt = 0;
          this.deps.store.setRuntime(this.id, { lastNotifyAt: 0 });
        }
      }
      return;
    }

    this.confirmCount += 1;
    const needRounds = Math.max(cfg.requireConfirmRounds || 1, this.target.confirmRounds || 1);
    if (this.confirmCount < needRounds) {
      this.deps.logger.debug('monitor', `${this.label} 第 ${this.confirmCount}/${needRounds} 次确认中`);
      return;
    }

    // 拍卖：同一 auction id 只通知一次
    if (this.target.kind === 'auction' && snap.bestOrder?.id) {
      if (this.notifiedAuctionIds.has(snap.bestOrder.id)) return;
    }

    const now = Date.now();
    const cooldownMs = (cfg.cooldownSec || 0) * 1000;
    const withinCooldown = this.lastNotifyAt && now - this.lastNotifyAt < cooldownMs;
    const improved =
      this.lastNotifyPrice != null &&
      snap.bestPrice != null &&
      (this.target.direction === 'sell'
        ? snap.bestPrice > this.lastNotifyPrice + (cfg.improveDelta || 0)
        : snap.bestPrice < this.lastNotifyPrice - (cfg.improveDelta || 0));

    if (withinCooldown && !improved) {
      this.deps.logger.debug('monitor', `${this.label} 冷却中，跳过通知`);
      return;
    }

    if (this.target.kind === 'auction' && snap.bestOrder?.id) {
      this.notifiedAuctionIds.add(snap.bestOrder.id);
      if (this.notifiedAuctionIds.size > 500) {
        this.notifiedAuctionIds = new Set(Array.from(this.notifiedAuctionIds).slice(-300));
      }
    }

    this.lastNotifyAt = now;
    this.lastNotifyPrice = snap.bestPrice;
    this.notifyCount += 1;
    this.deps.store.setRuntime(this.id, {
      lastNotifyAt: this.lastNotifyAt,
      lastNotifyPrice: this.lastNotifyPrice,
      notifiedAuctionIds: Array.from(this.notifiedAuctionIds).slice(-200),
    });

    const msg = this.buildMessage(snap);
    const result = await this.deps.notifier.dispatch({
      title: msg.title,
      body: msg.body,
      emailSubject: msg.emailSubject,
      emailHtml: msg.emailHtml,
      event: { kind: 'trigger', targetId: this.id, targetLabel: this.label, price: snap.bestPrice },
      urgency: 'normal',
    });

    const ev = {
      id: `${this.id}_${now}`,
      ts: now,
      kind: 'trigger',
      targetId: this.id,
      targetLabel: this.label,
      slug: this.target.slug || null,
      weaponSlug: this.target.weaponSlug || null,
      kindLabel: this.target.kind,
      price: snap.bestPrice,
      targetPrice: snap.targetPrice,
      direction: this.target.direction,
      bestOrder: snap.bestOrder,
      message: msg.body,
      channels: result.results,
      suppressed: result.suppressed || false,
    };
    this.deps.store.appendEvent(ev);
    this.emit('trigger', ev);
  }

  _attrName(slug) {
    if (!this._attrMap || this._attrLang !== this.uiLang) {
      this._attrLang = this.uiLang;
      this._attrMap = new Map();
      const en = this.uiLang === 'en';
      for (const a of this.deps.catalog.attrs()) this._attrMap.set(a.slug, en ? (a.en || a.zh) : (a.zh || a.en));
    }
    return this._attrMap.get(slug) || slug;
  }

  get uiLang() {
    return this.deps.config.get().ui?.language === 'en' ? 'en' : 'zh';
  }

  /** 站点根地址：英文界面去官方英文站，中文界面去 zh-hans */
  get siteRoot() {
    return this.uiLang === 'en' ? 'https://warframe.market' : 'https://warframe.market/zh-hans';
  }

  get itemUrl() {
    const t = this.target;
    if (t.slug) return `${this.siteRoot}/items/${t.slug}`;
    if (t.kind === 'auction' && t.weaponSlug) return `${this.siteRoot}/auctions?weapon_url_name=${t.weaponSlug}`;
    return this.siteRoot;
  }

  /** 通知里用的物品名：跟随界面语言取官方中文/英文名 */
  get dispName() {
    const t = this.target;
    const zh = t.nameZh || '';
    const en = t.nameEn || '';
    return this.uiLang === 'en' ? (en || zh || t.slug || t.weaponSlug || '') : (zh || en || t.slug || t.weaponSlug || '');
  }

  buildMessage(snap) {
    const t = this.target;
    const en = this.uiLang === 'en';
    const L = (zhStr, enStr) => (en ? enStr : zhStr);
    const fmt = (n) => (n == null ? '--' : `${n}p`);
    const statusText = en
      ? { ingame: 'in game', online: 'online', offline: 'offline' }
      : { ingame: '游戏中', online: '在线', offline: '离线' };
    const kindText = t.kind === 'auction' ? L('紫卡拍卖', 'Riven auction') : L('市场', 'Market');
    const dirText = t.kind === 'auction'
      ? L('一口价', 'buyout')
      : t.direction === 'sell' ? L('收购价', 'buy') : L('出售价', 'sell');
    const sep = en ? ' · ' : '｜';
    const comma = en ? ', ' : '，';
    const name = this.dispName;

    const title = en
      ? `[Hit] ${name} · ${fmt(snap.bestPrice)}`
      : `【达标】${name} · ${fmt(snap.bestPrice)}`;
    const lines = [];

    lines.push(
      `${kindText}${sep}${dirText} ${fmt(snap.bestPrice)}${comma}${L('目标', 'target')} ${t.direction === 'sell' && t.kind !== 'auction' ? '≥' : '≤'} ${fmt(snap.targetPrice)}`
    );
    if (snap.delta != null) {
      lines.push(
        en
          ? `Margin: ${fmt(Math.abs(snap.delta))} (${snap.delta >= 0 ? 'better than target' : 'just short'})`
          : `空间：${fmt(Math.abs(snap.delta))}（${snap.delta >= 0 ? '优于目标' : '差一点'}）`
      );
    }

    const o = snap.bestOrder;
    if (o) {
      const st = o.user?.status ? ` (${statusText[o.user.status] || o.user.status})` : '';
      const rep = o.user?.reputation != null ? `${sep}${L('信誉', 'rep')} ${o.user.reputation}` : '';
      lines.push(`${L('卖家', 'Seller')}: ${o.user?.name || L('未知', 'unknown')}${st}${rep}`);
      if (t.kind === 'market') lines.push(`${L('数量', 'Qty')}: ${o.quantity}${sep}${L('单笔', 'per trade')} ${o.perTrade ?? 1}`);
      if (t.kind === 'auction') {
        const attrs = (o.attributes || [])
          .map((a) => `${a.value > 0 ? '+' : ''}${a.value}% ${this._attrName(a.url_name)}`)
          .join(comma);
        if (attrs) lines.push(`${L('词条', 'Stats')}: ${attrs}`);
        if (o.reRolls != null) lines.push(`${L('洗练', 'Rolls')}: ${o.reRolls}${sep}${L('段位', 'MR')} ${o.mastery ?? '--'}`);
      }
    }

    // 达标价如果不是全网最低，补一句「还有更低的，但大概率买不到」。
    // 实测最便宜的挂单常来自离线号，不说清楚用户会白跑一趟。
    if (snap.allBest && snap.allBest.order) {
      const ab = snap.allBest;
      const au = ab.order.user || {};
      const ast = au.status ? ` (${statusText[au.status] || au.status})` : '';
      const aup = ab.order.updatedAt ? `${sep}${L('最后更新', 'updated')} ${agoText(ab.order.updatedAt, en)}` : '';
      lines.push(
        en
          ? `Also listed from ${fmt(ab.price)}${ast}${aup} — may not be tradable now`
          : `另有全网最低 ${fmt(ab.price)}${ast}${aup}，可能无法立即交易`
      );
    }

    const cnt = snap.countAtTarget || 0;
    lines.push(
      en
        ? `Matched orders: ${cnt > 99 ? '99+' : cnt} (of ${snap.totalEligible})`
        : `达标挂单：${cnt > 99 ? '99+' : cnt} 条（符合筛选共 ${snap.totalEligible} 条）`
    );
    lines.push(`${L('时间', 'Time')}: ${new Date(snap.ts).toLocaleString(en ? 'en-US' : 'zh-CN')}`);
    lines.push(this.itemUrl);

    const emailSubject = en
      ? `[warframe.market hit] ${name} · ${fmt(snap.bestPrice)}`
      : `【warframe.market 达标】${name} · ${fmt(snap.bestPrice)}`;
    return { title, body: lines.join('\n'), emailSubject, emailHtml: this.buildEmailHtml(snap, lines) };
  }

  /** 邮件正文版式：一张卡片，标题讲清"什么物品达标了"，表格给完整快照 */
  buildEmailHtml(snap, lines) {
    const t = this.target;
    const en = this.uiLang === 'en';
    const L = (zhStr, enStr) => (en ? enStr : zhStr);
    const fmt = (n) => (n == null ? '--' : `${n}p`);
    const statusText = en
      ? { ingame: 'in game', online: 'online', offline: 'offline' }
      : { ingame: '游戏中', online: '在线', offline: '离线' };
    const o = snap.bestOrder || {};
    const kindText = t.kind === 'auction' ? L('紫卡拍卖', 'Riven auction') : L('市场挂单', 'Market order');
    const dirText = t.kind === 'auction'
      ? (t.auctionMode === 'bid' ? L('当前竞价', 'current bid') : L('一口价', 'buyout'))
      : (t.direction === 'sell' ? L('最高收购价', 'highest buy') : L('最低出售价', 'lowest sell'));
    const link = this.itemUrl;

    const row = (k, v) => `<tr>
      <td style="padding:7px 0;color:#7b8794;font-size:13px;width:110px;vertical-align:top">${escapeHtml(k)}</td>
      <td style="padding:7px 0;color:#1f2733;font-size:13px;font-weight:500">${v}</td>
    </tr>`;

    const attrs = (o.attributes || [])
      .map((a) => `${a.value > 0 ? '+' : ''}${a.value}% ${this._attrName(a.url_name)}`)
      .join(en ? ', ' : '，');

    // 全网最低（含离线）单独一行，只在确实比达标价更低时出现
    let allBestRow = '';
    if (snap.allBest && snap.allBest.order) {
      const ab = snap.allBest;
      const st = statusText[ab.order.user?.status] || (en ? 'offline' : '离线');
      allBestRow = row(
        L('全网最低', 'Also listed'),
        `<span style="color:#a35d05;font-weight:600">${fmt(ab.price)}</span>`
          + `<span style="color:#7b8794;font-size:12px"> · ${escapeHtml(st)} · ${escapeHtml(agoText(ab.order.updatedAt, en))}${en ? ' · may not be tradable now' : ' · 可能无法立即交易'}</span>`
      );
    }

    const rows = [
      row(L('监控类型', 'Type'), escapeHtml(kindText)),
      row(L('目标价', 'Target'), `${t.direction === 'sell' && t.kind !== 'auction' ? '≥' : '≤'} ${fmt(snap.targetPrice)}`),
      row(dirText, `<span style="color:#0f766e;font-weight:700">${fmt(snap.bestPrice)}</span>`),
      row(L('差价', 'Gap'), snap.delta == null ? '--' : `${fmt(Math.abs(snap.delta))}${en ? ' better than target' : '（优于目标）'}`),
      o.user ? row(L('卖家', 'Seller'), `${escapeHtml(o.user.name)}${o.user.status ? ` (${statusText[o.user.status] || o.user.status})` : ''}${o.user.reputation != null ? ` · ${L('信誉', 'rep')} ${o.user.reputation}` : ''}`) : '',
      t.kind === 'market' && o.quantity ? row(L('数量', 'Qty'), `${o.quantity}${o.perTrade ? ` / ${L('单笔', 'per trade')} ${o.perTrade}` : ''}`) : '',
      t.kind === 'auction' && attrs ? row(L('词条', 'Stats'), escapeHtml(attrs)) : '',
      t.kind === 'auction' && o.reRolls != null ? row(L('洗练 / 段位', 'Rolls / MR'), `${o.reRolls} / ${o.mastery ?? '--'}`) : '',
      allBestRow,
      row(L('达标挂单', 'Matched'), `${(snap.countAtTarget || 0) > 99 ? '99+' : snap.countAtTarget}${en ? '' : ' 条'}`),
      row(L('时间', 'Time'), new Date(snap.ts).toLocaleString(en ? 'en-US' : 'zh-CN')),
    ].filter(Boolean).join('');

    return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px 12px;background:#eef2f6;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.08)">
    <tr><td style="background:#111a24;padding:16px 22px">
      <div style="color:#e0b354;font-size:12px;letter-spacing:2px;text-transform:uppercase">warframe.market</div>
      <div style="color:#ffffff;font-size:17px;font-weight:600;margin-top:4px">${L('价格达标提醒', 'Price target reached')}</div>
    </td></tr>
    <tr><td style="padding:22px">
      <div style="font-size:19px;font-weight:700;color:#111a24;line-height:1.4">${escapeHtml(this.dispName)}</div>
      <div style="margin-top:6px;font-size:28px;font-weight:800;color:#0f766e;letter-spacing:-.5px">${fmt(snap.bestPrice)}</div>
      <div style="margin-top:2px;color:#7b8794;font-size:12.5px">${L(`已达到你设定的目标价 ${fmt(snap.targetPrice)}`, `Reached your target of ${fmt(snap.targetPrice)}`)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #e6ebf0;border-bottom:1px solid #e6ebf0">
        ${rows}
      </table>
      <div style="margin-top:20px">
        <a href="${link}" style="display:inline-block;background:#e0b354;color:#191307;text-decoration:none;font-weight:600;font-size:13px;padding:10px 18px;border-radius:8px">${L('打开 warframe.market 查看', 'Open on warframe.market')}</a>
      </div>
      <div style="margin-top:18px;padding:12px 14px;background:#f6f8fa;border-radius:8px;color:#5b6672;font-size:12px;line-height:1.7;white-space:pre-wrap">${escapeHtml(lines.join('\n'))}</div>
    </td></tr>
    <tr><td style="padding:14px 22px;background:#f6f8fa;color:#93a1af;font-size:11.5px">
      ${L('本邮件由 WFM 价格监控自动发送 · 价格是读取瞬间的快照，下单前请再核对', 'Sent automatically by WFM Monitor · prices are a snapshot, double-check before trading')}
    </td></tr>
  </table>
</body></html>`;
  }

  view(durationMs = null) {
    const t = this.target;
    return {
      id: this.id,
      target: t,
      label: this.label,
      state: this.state,
      busy: this.busy,
      lastCheckAt: this.lastCheckAt,
      lastSuccessAt: this.lastSuccessAt,
      nextRunAt: this.nextRunAt,
      nextInMs: Math.max(0, this.nextRunAt - Date.now()),
      failures: this.failures,
      lastError: this.lastError,
      snapshot: this.snapshot,
      checkCount: this.checkCount,
      notifyCount: this.notifyCount,
      durationMs,
      history: this.deps.store.getHistory(this.id).slice(-120),
    };
  }
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ISO 时间 → 「3 小时前」，用于说明挂单的新鲜度 */
function agoText(iso, en) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return en ? 'unknown' : '未知';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return en ? 'just now' : '刚刚';
  if (mins < 60) return en ? `${mins}m ago` : `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return en ? `${hours}h ago` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return en ? `${days}d ago` : `${days} 天前`;
}

module.exports = { Monitor, fmtDuration };
