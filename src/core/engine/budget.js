'use strict';

/**
 * 引擎层 - 全局请求预算
 *
 * 为什么需要这一层：
 * 调度从「每个目标固定检查间隔」改成「按优先级分档」之后，用户可以把所有目标
 * 都设成高档，请求量会直接撞天花板。这一层在中间做闸门——超了就按优先级
 * 降级低档目标，而不是让限速器把所有人一起卡住。
 *
 * 为什么预算按「带宽」而不是按「限速」：
 * 限速器只约束「每秒发几次」（默认 2 次/秒），但实测热门物品单次订单响应
 * gzip 后仍有 35–113 KB。10 个目标按 20 秒一轮就是 126 MB/小时。
 * 频次完全没超，流量已经离谱。所以容量按「每分钟能吃多少 KB」反推。
 *
 * 纯状态机，不碰网络、不碰配置对象，可直接单测（见 scripts/test-budget.js）。
 */

const TIER_RANK = { high: 0, normal: 1, low: 2 };
const TIER_MS = { high: 20000, normal: 60000, low: 180000 };
const LEVEL_FACTOR = [1, 2, 3];

class BudgetAllocator {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
    this.enabled = true;
    this.capacity = 20;
    this.tokens = 20;
    this.lastRefillAt = Date.now();
    this.windowStartAt = Date.now();
    this.tiers = new Map(); // targetId -> 'high' | 'normal' | 'low'
    this.states = new Map(); // targetId -> { level, skips, lastGrantAt, lastSkipAt }
    this.stats = { granted: 0, denied: 0, manual: 0 };
  }

  /**
   * 容量 = min(带宽可承受次数, 限速可承受次数)，并有下限保护。
   * avgKbPerCheck 由调用方用 client.stats.bytes / ok 做 EWMA 送进来，
   * 所以 gzip 生效后这个值会自己掉到 ~70，容量自动翻倍，无需另写适配。
   */
  configure({ enabled, bandwidthKbPerMin, avgKbPerCheck, minChecksPerMin, minRequestIntervalMs } = {}) {
    if (enabled != null) this.enabled = !!enabled;
    const rateCap = Math.floor(60000 / Math.max(340, Number(minRequestIntervalMs) || 500));
    const bwCap = Math.floor((Number(bandwidthKbPerMin) || 6000) / Math.max(20, Number(avgKbPerCheck) || 300));
    const next = Math.max(Number(minChecksPerMin) || 6, Math.min(bwCap, rateCap));
    if (next !== this.capacity) {
      this.capacity = next;
      this.tokens = Math.min(this.tokens, next);
    }
    return this.capacity;
  }

  tierOf(id) {
    return this.tiers.get(id) || 'normal';
  }

  setTier(id, tier) {
    this.tiers.set(id, TIER_RANK[tier] != null ? tier : 'normal');
  }

  remove(id) {
    this.tiers.delete(id);
    this.states.delete(id);
  }

  _st(id) {
    let s = this.states.get(id);
    if (!s) {
      s = { level: 0, skips: 0, lastGrantAt: 0, lastSkipAt: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  levelOf(id) {
    return this._st(id).level;
  }

  factorOf(id) {
    return LEVEL_FACTOR[this._st(id).level] || 1;
  }

  baseMsOf(id) {
    return TIER_MS[this.tierOf(id)] || TIER_MS.normal;
  }

  /** 逾期程度归一化：同一个目标的等待时间除以它的基准间隔，越久越该跑 */
  _overdueNorm(m, now) {
    const base = this.baseMsOf(m.id);
    return (now - (m.nextRunAt || now)) / Math.max(1000, base);
  }

  _refill(now) {
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / this.windowMs) * this.capacity);
      this.lastRefillAt = now;
    }
    // 跨窗口结算：上一窗口一次都没被拒（说明不紧张）才回落一级，防止来回振荡
    if (now - this.windowStartAt >= this.windowMs) {
      const quiet = (this._windowDenied || 0) === 0;
      if (quiet) {
        for (const st of this.states.values()) {
          if (st.skips === 0) st.level = Math.max(0, st.level - 1);
        }
      }
      for (const st of this.states.values()) st.skips = 0;
      this._windowDenied = 0;
      this.windowStartAt = now;
    }
  }

  noteDenied(id, now) {
    this.stats.denied += 1;
    this._windowDenied = (this._windowDenied || 0) + 1;
    const st = this._st(id);
    st.skips += 1;
    st.lastSkipAt = now;
    // 连续被跳过才降级：一次被挤掉可能只是瞬时的并发占位
    if (st.skips >= 5) st.level = 2;
    else if (st.skips >= 2) st.level = Math.max(st.level, 1);
  }

  noteGranted(id, now) {
    const st = this._st(id);
    st.lastGrantAt = now;
    st.skips = 0;
  }

  /**
   * 从到期队列里挑出这一轮真正要跑的目标。
   * 手动触发（forceRun）不校验预算，但会计数，这样设置页显示的是真实用量。
   */
  pick(due, { now = Date.now(), slots = 1 } = {}) {
    const limit = Math.max(0, slots);
    if (!this.enabled) return due.slice(0, limit);
    this._refill(now);

    const manual = due.filter((m) => m.forceRun);
    const rest = due.filter((m) => !m.forceRun);
    rest.sort((a, b) => {
      const ra = TIER_RANK[this.tierOf(a.id)];
      const rb = TIER_RANK[this.tierOf(b.id)];
      if (ra !== rb) return ra - rb;
      return (
        this._overdueNorm(b, now) - this._overdueNorm(a, now) ||
        (a.failures || 0) - (b.failures || 0) ||
        (a.nextRunAt || 0) - (b.nextRunAt || 0)
      );
    });

    const out = [];
    let left = limit;
    for (const m of manual.concat(rest)) {
      if (left <= 0) {
        if (!m.forceRun) this.noteDenied(m.id, now);
        continue;
      }
      if (!m.forceRun) {
        if (this.tokens < 1) {
          this.noteDenied(m.id, now);
          continue;
        }
        this.tokens -= 1;
        this.stats.granted += 1;
      } else {
        this.stats.manual += 1;
      }
      this.noteGranted(m.id, now);
      out.push(m);
      left -= 1;
    }
    return out;
  }

  snapshot() {
    const used = Math.max(0, this.capacity - this.tokens);
    const degraded = [];
    for (const [id, st] of this.states) {
      if (st.level > 0) degraded.push({ id, level: st.level, factor: LEVEL_FACTOR[st.level] });
    }
    return {
      enabled: this.enabled,
      capacity: this.capacity,
      used: Math.round(used),
      utilization: this.capacity ? +(used / this.capacity).toFixed(2) : 0,
      degraded,
    };
  }
}

module.exports = { BudgetAllocator, TIER_MS, TIER_RANK, LEVEL_FACTOR };
