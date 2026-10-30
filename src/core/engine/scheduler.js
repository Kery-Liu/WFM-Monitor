'use strict';

/**
 * 调度层 - 全局调度器
 * 职责：统一节拍、分布各目标的检查时刻、控制同时在飞的监控数、
 *       把实时流推来的订单就近分发给对应监控单元。
 * 目的：避免所有目标在同一秒一起打接口（需求 4 的「分层构筑，避免拥挤」）。
 */

const { EventEmitter } = require('events');
const { Monitor } = require('./monitor');
const { FairShare } = require('./budget');

class Scheduler extends EventEmitter {
  constructor({ config, logger, store, marketSource, auctionSource, notifier, catalog }) {
    super();
    this.config = config;
    this.logger = logger;
    this.store = store;
    this.marketSource = marketSource;
    this.auctionSource = auctionSource;
    this.notifier = notifier;
    this.catalog = catalog;
    this.monitors = new Map();
    this.timer = null;
    this._inflight = 0;
    this._ticking = false;
    this.startedAt = 0;
    this.stats = { ticks: 0, checks: 0, triggers: 0, errors: 0 };
    this.budget = new FairShare();
    this._avgKb = null;
    this._lastCalib = 0;
    this.syncBudget();
  }

  get autoMode() {
    const s = this.config.get().schedule;
    return !!(s && s.auto);
  }

  /** 把配置里的容量参数推给分配器（开关注释：改设置后要立刻调用） */
  syncBudget() {
    const s = this.config.get().schedule || {};
    const b = s.budget || {};
    return this.budget.configure({
      bandwidthKbPerMin: b.bandwidthKbPerMin,
      avgKbPerCheck: this._avgKb != null ? this._avgKb : b.avgKbPerCheck,
      minChecksPerMin: b.minChecksPerMin,
      minRequestIntervalMs: this.config.get().global.minRequestIntervalMs,
    });
  }

  /**
   * v1.3.0→1.2.1：配额分配制。把当前所有目标的档位/状态交给 FairShare 重算，
   * 并把算出的间隔写回各 monitor。O(n) 纯计算，每跳调用都无压力。
   * 间隔变化不重排 nextRunAt——在下一次 scheduleIn 时自然生效。
   */
  _redistribute() {
    if (!this.autoMode) return;
    const list = [];
    for (const m of this.monitors.values()) {
      if (!m.target.enabled) continue;
      list.push({ id: m.id, priority: m.target.priority, matched: m.isMatched, near: m.isNearTarget });
    }
    this.budget.recompute(list);
    for (const m of this.monitors.values()) {
      m.setAssignedInterval(this.budget.intervalOf(m.id));
    }
  }

  /**
   * 用真实流量校准「每次检查多少 KB」。
   * gzip 生效后这个值会自己掉到 ~70，配额随之变大，所有目标的间隔自动缩短，
   * 不需要另写适配。每 30 秒最多一次，避免每跳都算。
   */
  _calibBudget(now) {
    if (now - this._lastCalib < 30000) return;
    this._lastCalib = now;
    const b = (this.config.get().schedule || {}).budget || {};
    if (b.calibrate === false) return;
    const st = this.marketSource && this.marketSource.client && this.marketSource.client.stats;
    if (!st || !st.ok) return;
    const measured = st.bytes / st.ok / 1024;
    if (!Number.isFinite(measured) || measured <= 0) return;
    const prev = this._avgKb != null ? this._avgKb : Number(b.avgKbPerCheck) || 300;
    this._avgKb = Math.max(20, Math.min(800, prev * 0.8 + measured * 0.2));
    this.syncBudget();
  }

  get maxInflight() {
    return Math.max(1, Number(this.config.get().global.maxConcurrent) || 2);
  }

  deps() {
    return {
      config: this.config,
      logger: this.logger,
      store: this.store,
      marketSource: this.marketSource,
      auctionSource: this.auctionSource,
      notifier: this.notifier,
      catalog: this.catalog,
    };
  }

  loadAll() {
    const list = this.store.listTargets();
    for (const t of list) this._attach(t);
    this.logger.info('scheduler', `已载入 ${this.monitors.size} 个监控目标`);
    this.setPaused(!!this.config.get().global.paused);
  }

  _attach(target) {
    const m = new Monitor({ target, deps: this.deps() });
    m.on('update', (v) => this.emit('update', v));
    m.on('trigger', (ev) => {
      this.stats.triggers += 1;
      this.emit('trigger', ev);
    });
    m.on('error', (e) => {
      this.stats.errors += 1;
      this.emit('monitor-error', e);
    });
    // 首次执行时刻错开，避免启动瞬间全部并发。
    // 注意这里必须用 intervalMs（固定间隔）而不是 effectiveIntervalMs：
    // 否则一个 intervalSec=3600 的老目标会被排到 180 秒后才首跑，回归会直接挂。
    const spread = Math.random() * Math.min(8000, m.intervalMs);
    m.scheduleIn(600 + spread);
    this.monitors.set(target.id, m);
    this._redistribute();
    return m;
  }

  addTarget(target) {
    const m = this._attach(target);
    this.emit('update', m.view());
    this.logger.info('scheduler', `新增监控：${m.label}（${target.kind}）`);
    return m;
  }

  updateTarget(target) {
    const m = this.monitors.get(target.id);
    if (!m) return this.addTarget(target);
    const prev = m.target;
    const intervalChanged = prev.intervalSec !== target.intervalSec;
    const reEnabled = !prev.enabled && target.enabled;
    const nowDisabled = prev.enabled && !target.enabled;
    // 编辑时可以把监控对象整个换掉：slug / 武器 / 类型变了就不能沿用旧缓存
    const identityChanged =
      prev.kind !== target.kind ||
      (prev.slug || '') !== (target.slug || '') ||
      (prev.weaponSlug || '') !== (target.weaponSlug || '') ||
      (!!prev.itemId && !!target.itemId && prev.itemId !== target.itemId);
    m.target = target;
    this._redistribute(); // 档位可能变了，配额重新分配

    if (identityChanged) {
      m.resetForNewItem();
      m.state = target.enabled ? 'idle' : 'disabled';
      if (target.enabled) m.scheduleIn(300); // 换了对象 → 立刻取一次新数据
    } else {
      // 目标价/方向/筛选变了：立刻用本地订单缓存重算，否则卡片和详情页的差距
      // 会停留在旧规则上，直到下一轮轮询（最长一个 interval）
      const ruleChanged = m.refreshSnapshot();
      if (nowDisabled) {
        // 停用 = 立即刹车：清空下次调度，状态标记为 disabled
        m.state = 'disabled';
        m.nextRunAt = 0;
      } else if (reEnabled) {
        m.state = this.config.get().global.paused ? 'paused' : 'idle';
        if (!this.config.get().global.paused) m.scheduleIn(300); // 重新启用 → 立刻跑一次
      } else if (intervalChanged) {
        m.scheduleIn(500);
      } else if (ruleChanged && m.target.enabled && m.state !== 'checking' && m.state !== 'error') {
        // 快照已按新规则重算，状态跟着达标结果走
        m.state = m.snapshot?.matched ? 'trigger' : 'ok';
      }
    }
    this.emit('update', m.view());
    return m;
  }

  /** 全局暂停/恢复：只改运行态，绝不动 target.enabled */
  setPaused(paused) {
    for (const m of this.monitors.values()) {
      if (!m.target.enabled) {
        m.state = 'disabled';
        m.nextRunAt = 0;
      } else if (paused) {
        m.state = 'paused';
        m.nextRunAt = 0;
      } else {
        m.state = 'idle';
        m.scheduleIn(400 + Math.random() * 1500);
      }
      this.emit('update', m.view());
    }
  }

  removeTarget(id) {
    const m = this.monitors.get(id);
    if (!m) return false;
    m.removeAllListeners();
    this.monitors.delete(id);
    this.budget.remove(id);
    this._redistribute(); // 份额让给剩下的目标
    this.emit('removed', { id });
    return true;
  }

  getMonitor(id) {
    return this.monitors.get(id) || null;
  }

  views() {
    return Array.from(this.monitors.values()).map((m) => m.view());
  }

  start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this._tick(), 500);
    if (this.timer.unref) this.timer.unref();
    this.logger.info('scheduler', '调度器已启动');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    if (this._ticking) return;
    this._ticking = true;
    this.stats.ticks += 1;
    try {
      const now = Date.now();
      const paused = this.config.get().global.paused;
      const due = [];
      for (const m of this.monitors.values()) {
        if (m.busy) continue;
        if (!m.nextRunAt || m.nextRunAt > now) continue;
        // 停用目标不自动跑；全局暂停时不自动跑
        if (!m.target.enabled && !m.forceRun) continue;
        if (paused && !m.forceRun) continue;
        due.push(m);
      }
      if (!due.length) return;

      const slots = this.maxInflight - this._inflight;
      if (slots <= 0) return;

      this._calibBudget(now);
      // 每跳重算配额：O(n) 纯计算，状态翻转（达标/接近）下一跳就反映到间隔
      this._redistribute();

      // 到期目标按「逾期程度 ÷ 各自分到的间隔」排序，谁等得越久越优先，结构上不饿死
      const rank = (m) => (now - (m.nextRunAt || now)) / Math.max(1000, m.effectiveIntervalMs);
      due.sort((a, b) => rank(b) - rank(a) || a.failures - b.failures);
      const grants = due.slice(0, slots);

      for (const m of grants) {
        this._inflight += 1;
        this.stats.checks += 1;
        m.tick()
          .catch(() => {})
          .finally(() => {
            this._inflight = Math.max(0, this._inflight - 1);
          });
      }
    } finally {
      this._ticking = false;
    }
  }

  /**
   * 切换自动 / 固定调度。
   * 必须立刻重排所有目标的 nextRunAt，否则用户拨了开关要等一个完整间隔才看到变化，
   * 会误判「开关是假的」。
   */
  setMode() {
    this.syncBudget();
    for (const m of this.monitors.values()) {
      if (!m.target.enabled) {
        m.state = 'disabled';
        m.nextRunAt = 0;
      } else if (this.config.get().global.paused) {
        m.state = 'paused';
        m.nextRunAt = 0;
      } else {
        m.state = 'idle';
        m.scheduleIn(400 + Math.random() * 1500);
      }
      this.emit('update', m.view());
    }
  }

  /** 实时流推来的新订单 → 就近分发给相关监控单元 */
  handleRealtimeOrder(order) {
    if (!order || !order.itemId) return;
    const matched = [];
    for (const m of this.monitors.values()) {
      if (m.target.kind !== 'market') continue;
      if (m.target.itemId && m.target.itemId !== order.itemId) continue;
      if (!m.target.itemId && m.target.slug) {
        const it = this.catalog.bySlug(m.target.slug);
        if (!it || it.id !== order.itemId) continue;
      }
      matched.push(m);
    }
    if (!matched.length) return;
    for (const m of matched) {
      m.applyRealtime(order).catch((e) => this.logger.debug('scheduler', `实时分发失败：${e.message}`));
    }
  }

  status() {
    const list = Array.from(this.monitors.values());
    return {
      running: !!this.timer,
      startedAt: this.startedAt,
      targetCount: list.length,
      enabledCount: list.filter((m) => m.target.enabled).length,
      inflight: this._inflight,
      maxInflight: this.maxInflight,
      paused: !!this.config.get().global.paused,
      stats: this.stats,
      auto: this.autoMode,
      budget: this.budget.snapshot(),
    };
  }
}

module.exports = { Scheduler };
