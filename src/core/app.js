'use strict';

/**
 * 应用装配层（组合根）
 * 把各层拼起来，对上层（Electron IPC / HTTP API）暴露稳定接口。
 * 上层不关心内部实现，只调这里的方法。
 */

const EventEmitter = require('events');
const dns = require('dns').promises;
const path = require('path');

const { Config } = require('./config');
const { Logger } = require('./logger');
const { Store } = require('./store/store');
const { HttpClient } = require('./http/client');
const { Catalog } = require('./sources/catalog');
const { MarketSource } = require('./sources/market');
const { AuctionSource } = require('./sources/auction');
const { OrderStream, WS_URL } = require('./sources/stream');
const { Resolver } = require('./domain/resolver');
const { Scheduler } = require('./engine/scheduler');
const { Notifier } = require('./notify');
const { EmailControl } = require('./control');
const { sanitizeTarget } = require('./domain/rules');
const { uid, fmtDuration } = require('./util');
const { KINDS } = require('./errors');

class App extends EventEmitter {
  constructor({ dataDir, hooks = {} }) {
    super();
    this.dataDir = dataDir;
    this.hooks = hooks;
    this.startedAt = 0;
    this._booted = false;
  }

  async init() {
    if (this._booted) return;
    this.config = new Config(this.dataDir);
    this.logger = new Logger({ capacity: 800, level: 'info' });
    this.logger.onRecord((rec) => this.emit('log', rec));

    this.store = new Store({ dataDir: this.dataDir, logger: this.logger });
    this.client = new HttpClient({ config: this.config, logger: this.logger });
    this.catalog = new Catalog({ client: this.client, logger: this.logger, dataDir: this.dataDir });
    this.resolver = new Resolver({ catalog: this.catalog });
    this.marketSource = new MarketSource({ client: this.client, logger: this.logger });
    this.auctionSource = new AuctionSource({ client: this.client, logger: this.logger });
    this.notifier = new Notifier({ config: this.config, logger: this.logger, hooks: this.hooks });
    this.control = new EmailControl({ config: this.config, logger: this.logger, app: this });
    this.stream = new OrderStream({ config: this.config, logger: this.logger });

    this.scheduler = new Scheduler({
      config: this.config,
      logger: this.logger,
      store: this.store,
      marketSource: this.marketSource,
      auctionSource: this.auctionSource,
      notifier: this.notifier,
      catalog: this.catalog,
    });

    this.scheduler.on('update', (v) => this.emit('target-update', v));
    this.scheduler.on('trigger', (ev) => this.emit('trigger', ev));
    this.scheduler.on('removed', (p) => this.emit('target-removed', p));
    this.scheduler.on('monitor-error', (e) => this.emit('monitor-error', e));

    this.stream.on('order', (o) => this.scheduler.handleRealtimeOrder(o));
    this.stream.on('state', (s) => this.emit('stream-state', s));

    this.scheduler.loadAll();
    this.scheduler.start();
    if (this.control) this.control.start();
    this.stream.start();
    this.startedAt = Date.now();

    // 后台预热清单（不阻塞启动）
    this.catalog.ensureFresh().catch((e) => this.logger.warn('app', `清单预热失败：${e.message}`));
    this.logger.info('app', '应用已启动');
    this._booted = true;
  }

  async shutdown() {
    try {
      this.stream.stop();
      this.scheduler.stop();
      if (this.control) this.control.stop();
      this.store.flushHistory(true);
      this.store.flushRuntime(true);
      this.store.flushTargets();
    } catch (_) {}
  }

  // ---------------- 搜索 ----------------
  async ensureCatalog() {
    if (!this.catalog.ready) await this.catalog.ensureFresh();
    return this.catalog;
  }

  async searchItems(q) {
    await this.ensureCatalog();
    const r = this.resolver.searchItems(q, 10);
    let hint = null;
    if (r.confidence === 'none') {
      // 物品库里没有 → 可能用户想找的是「武器的紫卡」
      const w = this.resolver.searchWeapons(q, 3);
      if (w.best && w.confidence !== 'none') {
        hint = `「${w.best.zh || w.best.en}」是武器本体，本身不可交易。你想找的可能是它的紫卡拍卖，可切换到「紫卡拍卖」。`;
      }
    }
    return {
      confidence: r.confidence,
      hint,
      candidates: r.candidates.map((c) => ({
        slug: c.slug,
        id: c.id,
        en: c.en,
        zh: c.zh,
        tags: c.tags,
        score: c.score,
        thumb: this.catalog.iconUrl(c.thumb),
        setRoot: c.setRoot,
        mr: c.mr,
      })),
    };
  }

  async searchWeapons(q) {
    await this.ensureCatalog();
    const r = this.resolver.searchWeapons(q, 10);
    return {
      confidence: r.confidence,
      candidates: r.candidates.map((c) => ({
        slug: c.slug,
        en: c.en,
        zh: c.zh,
        group: c.group,
        rivenType: c.rivenType,
        disposition: c.disposition,
        score: c.score,
      })),
    };
  }

  async listAttrs() {
    await this.ensureCatalog();
    return this.catalog.attrs();
  }

  /**
   * 物品详情（懒加载）：主要用来取套装的 setParts
   * 清单列表接口不返回 setParts，只有详情接口有，所以按需请求并缓存
   */
  async itemDetail(slug) {
    await this.ensureCatalog();
    if (!this._detailCache) this._detailCache = new Map();
    const hit = this._detailCache.get(slug);
    if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;

    const res = await this.client.request(`/v2/items/${encodeURIComponent(slug)}`, { priority: 4, label: `获取 ${slug} 详情` });
    const d = res.json?.data;
    if (!d) {
      const e = new Error(`物品不存在：${slug}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const parts = (d.setParts || [])
      .map((id) => this.catalog.byId(id))
      .filter((p) => p && p.id !== d.id) // 接口会把套装本体也列进去，去掉
      .map((p) => ({ slug: p.slug, id: p.id, zh: p.zh, en: p.en, tags: p.tags }));

    const data = {
      slug: d.slug,
      id: d.id,
      zh: d.i18n?.['zh-hans']?.name || '',
      en: d.i18n?.en?.name || d.slug,
      setRoot: !!d.setRoot,
      quantityInSet: d.quantityInSet ?? null,
      parts,
    };
    this._detailCache.set(slug, { ts: Date.now(), data });
    return data;
  }

  // ---------------- 目标管理 ----------------
  targets() {
    return this.scheduler.views();
  }

  async addTarget(input) {
    await this.ensureCatalog();
    const t = sanitizeTarget({ ...input, id: input.id || uid('t'), createdAt: Date.now() });

    if (t.kind === 'market') {
      if (!t.slug) {
        const r = this.resolver.searchItems(input.query || '');
        const best = r.best;
        if (!best || r.confidence === 'none') {
          const err = new Error(`未找到匹配物品：「${input.query || ''}」`);
          err.code = 'UNRESOLVED';
          err.candidates = r.candidates;
          throw err;
        }
        t.slug = best.slug;
        t.itemId = best.id;
        t.nameEn = best.en;
        t.nameZh = best.zh;
      } else {
        const it = this.catalog.bySlug(t.slug);
        if (!it) {
          const err = new Error(`物品标识不存在：${t.slug}`);
          err.code = 'UNRESOLVED';
          throw err;
        }
        t.itemId = it.id;
        t.nameEn = it.en;
        t.nameZh = it.zh;
      }
    } else {
      const w = this.catalog.weaponBySlug(t.weaponSlug);
      if (!w) {
        const err = new Error(`紫卡武器不存在：${t.weaponSlug}`);
        err.code = 'UNRESOLVED';
        throw err;
      }
      t.nameZh = t.label || w.zh || w.en;
      t.nameEn = w.en;
    }

    if (!(t.targetPrice > 0)) {
      const err = new Error('请填写大于 0 的目标价');
      err.code = 'INVALID_TARGET';
      throw err;
    }

    this.store.upsertTarget(t);
    this.scheduler.addTarget(t);
    return t;
  }

  updateTarget(id, patch) {
    const cur = this.store.getTarget(id);
    if (!cur) throw new Error('目标不存在');
    const next = sanitizeTarget({ ...cur, ...patch, id });
    this.store.upsertTarget(next);
    this.scheduler.updateTarget(next);
    return next;
  }

  removeTarget(id) {
    this.store.removeTarget(id);
    return this.scheduler.removeTarget(id);
  }

  /** 跑一轮并等所有目标结束（远程指令用；无 UI 反馈，纯等待） */
  async checkAllAndWait() {
    const views = this.scheduler.views().filter((v) => v.target.enabled);
    const monitors = views.map((v) => this.scheduler.getMonitor(v.id)).filter(Boolean);
    const t0 = Date.now();
    await Promise.allSettled(
      monitors.map(async (m) => {
        m.forceRun = true;
        try {
          await m.tick();
        } catch (_) {}
      })
    );
    return { count: monitors.length, elapsed: Date.now() - t0 };
  }

  /** 供远程回复用的汇总行 */
  summaryRows(lang = 'zh') {
    const en = lang === 'en';
    return this.scheduler.views().map((v) => {
      const t = v.target;
      const snap = v.snapshot || {};
      return {
        label: en ? (t.nameEn || t.nameZh || t.label) : (t.nameZh || t.nameEn || t.label),
        enabled: !!t.enabled,
        state: v.state,
        kind: t.kind,
        direction: t.direction,
        bestPrice: snap.bestPrice ?? null,
        targetPrice: t.targetPrice,
        matched: !!snap.matched,
      };
    });
  }

  checkNow(id) {
    const m = this.scheduler.getMonitor(id);
    if (!m) return false;
    // 手动检查是明确的用户意图，即使目标已停用也允许跑一次，但不会改变启用状态
    m.requestNow(true);
    return true;
  }

  /** 全部检查：跳过已停用的目标（停用状态必须锁住） */
  checkAll() {
    const all = this.scheduler.views();
    let started = 0;
    let skipped = 0;
    for (const v of all) {
      if (!v.target.enabled) {
        skipped += 1;
        continue;
      }
      this.scheduler.getMonitor(v.id)?.requestNow();
      started += 1;
    }
    return { started, skipped };
  }

  // ---------------- 设置 ----------------
  settings() {
    return this.config.get();
  }

  saveSettings(patch) {
    const before = this.config.get();
    const next = this.config.patch(patch);
    this._afterSettingsChange(before, next);
    return next;
  }

  /** 恢复默认设置 */
  resetSettings() {
    const before = this.config.get();
    this.config.reset();
    const next = this.config.get();
    this._afterSettingsChange(before, next);
    this.logger.info('app', '设置已恢复默认');
    return next;
  }

  getDefaults() {
    return Config.defaults();
  }

  _afterSettingsChange(before, next) {
    const networkChanged =
      before.global.proxyUrl !== next.global.proxyUrl ||
      before.global.minRequestIntervalMs !== next.global.minRequestIntervalMs ||
      before.global.maxConcurrent !== next.global.maxConcurrent ||
      before.network.timeoutMs !== next.network.timeoutMs;
    if (networkChanged) this.client.reload();
    if (before.global.paused !== next.global.paused) this.scheduler.setPaused(!!next.global.paused);
    if (before.global.platform !== next.global.platform || before.global.crossplay !== next.global.crossplay) {
      this.stream.restart();
    }
    const controlChanged =
      JSON.stringify(before.control || {}) !== JSON.stringify(next.control || {});
    if (controlChanged && this.control) this.control.start();
    if (before.network.streamEnabled !== next.network.streamEnabled) {
      if (next.network.streamEnabled) this.stream.start();
      else this.stream.stop();
    }
  }

  // ---------------- 事件 ----------------
  events(limit = 200) {
    return this.store.recentEvents(limit);
  }

  clearEvents() {
    this.store.clearEvents();
    return true;
  }

  async testNotify() {
    return this.notifier.test();
  }

  async refreshCatalog() {
    await this.catalog.ensureFresh(true);
    return this.catalog.snapshotMeta();
  }

  // ---------------- 健康 ----------------
  status() {
    return {
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      scheduler: this.scheduler.status(),
      http: this.client.snapshot(),
      stream: this.stream.snapshot(),
      catalog: this.catalog.snapshotMeta(),
      notifier: { channels: this.notifier.activeChannels(), quiet: this.notifier.inQuietHours() },
      config: {
        platform: this.config.get().global.platform,
        language: this.config.get().global.language,
        proxy: this.config.get().global.proxyUrl || '',
        intervalMs: this.config.get().global.minRequestIntervalMs,
        maxConcurrent: this.config.get().global.maxConcurrent,
        paused: this.config.get().global.paused,
      },
    };
  }

  /**
   * 网络自检：分层探测，逐项给出「通/不通 + 原因 + 建议」
   * 这是需求 6/7 的落点：用户永远能看到「到底哪一层断了」。
   */
  async diagnose() {
    const results = [];
    this.client.breaker.reset();
    const push = (step, ok, detail, advice) => results.push({ step, ok, detail, advice: advice || null });
    const g = this.config.get().global;

    // 1. 代理配置
    if (g.proxyUrl) {
      const ok = /^https?:\/\/[^\s]+/.test(g.proxyUrl);
      push('代理配置', ok, ok ? `已配置：${g.proxyUrl}` : `格式不正确：${g.proxyUrl}`, ok ? null : '格式应为 http://127.0.0.1:7890');
    } else {
      push('代理配置', true, '未使用代理（直连）', null);
    }

    // 2. DNS
    const dnsStart = Date.now();
    try {
      const addrs = await Promise.race([
        dns.lookup('api.warframe.market', { all: true }),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('DNS 查询超时'), { code: 'ETIMEDOUT' })), 8000)),
      ]);
      push('DNS 解析', true, `api.warframe.market → ${addrs.map((a) => a.address).join(', ')}（${Date.now() - dnsStart}ms）`);
    } catch (e) {
      push('DNS 解析', false, `${e.code || ''} ${e.message}`,
        'DNS 解析失败：检查网络连接；若走代理，请开启「代理全局 DNS」或在代理软件里设置 DNS 转发。');
    }

    // 3. API 连通（小体积接口）
    try {
      const r = await this.client.request('/v2/items/ash_prime_set', { priority: 1, timeoutMs: 15000, retries: 0, bypassBreaker: true, label: 'API 探测' });
      push('API 连通', true, `HTTP ${r.status}｜${r.latencyMs}ms｜${(r.bytes / 1024).toFixed(1)}KB`);
    } catch (e) {
      const j = e.toJSON ? e.toJSON() : { kind: KINDS.UNKNOWN, message: e.message, advice: '' };
      push('API 连通', false, `[${j.kind}] ${j.message}`, j.advice);
    }

    // 4. 订单接口
    try {
      const r = await this.client.request('/v2/orders/item/ash_prime_set', { priority: 1, timeoutMs: 20000, retries: 0, bypassBreaker: true, label: '订单探测' });
      const n = Array.isArray(r.json?.data) ? r.json.data.length : 0;
      push('订单接口', true, `HTTP ${r.status}｜${r.latencyMs}ms｜返回 ${n} 条挂单`);
    } catch (e) {
      const j = e.toJSON ? e.toJSON() : { kind: KINDS.UNKNOWN, message: e.message, advice: '' };
      push('订单接口', false, `[${j.kind}] ${j.message}`, j.advice);
    }

    // 5. 拍卖接口
    try {
      const r = await this.client.request('/v1/auctions/search?type=riven&weapon_url_name=kuva_ayanga', { priority: 1, timeoutMs: 20000, retries: 0, bypassBreaker: true });
      const n = r.json?.payload?.auctions?.length || 0;
      push('拍卖接口', true, `HTTP ${r.status}｜${r.latencyMs}ms｜返回 ${n} 条拍卖`);
    } catch (e) {
      const j = e.toJSON ? e.toJSON() : { kind: KINDS.UNKNOWN, message: e.message, advice: '' };
      push('拍卖接口', false, `[${j.kind}] ${j.message}`, j.advice);
    }

    // 6. WebSocket
    await new Promise((resolve) => {
      let done = false;
      const WebSocket = require('ws');
      const t0 = Date.now();
      let ws;
      const finish = (ok, detail, advice) => {
        if (done) return;
        done = true;
        push('实时推送', ok, detail, advice);
        try {
          ws && ws.terminate();
        } catch (_) {}
        resolve();
      };
      try {
        ws = new WebSocket(WS_URL, 'wfm', {
          origin: 'https://warframe.market',
          handshakeTimeout: 10000,
          headers: { 'User-Agent': g.userAgent || 'WFM-Monitor/1.0' },
        });
      } catch (e) {
        return finish(false, e.message, 'WebSocket 初始化失败，请检查代理是否放行 wss 流量。');
      }
      ws.on('open', () => finish(true, `握手成功（${Date.now() - t0}ms）`, null));
      ws.on('error', (e) => finish(false, e.message, '实时推送不可用时，程序会自动退回纯轮询模式，监控不受影响。若需实时，请检查代理对 wss://ws.warframe.market 的放行。'));
      setTimeout(() => finish(false, '握手超时 10s', '可能是代理未放行 WebSocket，或当前网络屏蔽了 wss。可关闭实时推送，仅用轮询。'), 10500);
      return undefined;
    });

    // 7. 限速状态
    const snap = this.client.snapshot();
    push(
      '限速与熔断',
      snap.breaker.state === 'closed' && !snap.coolingDown,
      `熔断：${snap.breaker.state}｜冷却中：${snap.coolingDown ? '是' : '否'}｜排队：${snap.queued}｜成功率：${snap.successRate == null ? '--' : `${(snap.successRate * 100).toFixed(1)}%`}`,
      snap.breaker.state !== 'closed' ? '熔断已打开，说明近期连续失败。先解决上面的网络问题，熔断会在冷却时间后自动恢复。' : null
    );

    const allOk = results.every((r) => r.ok);
    return {
      ok: allOk,
      ts: Date.now(),
      results,
      summary: allOk
        ? '全部链路正常。'
        : `有 ${results.filter((r) => !r.ok).length} 项异常，按建议处理后点击「重新自检」。`,
    };
  }
}

module.exports = { App, fmtDuration, path };
