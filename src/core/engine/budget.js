'use strict';

/**
 * 引擎层 - 全局配额分配器（proportional fair share）
 *
 * 设计目标（v1.3.0）：
 * 旧版是「固定档位 + 超了才封顶」——目标少时预算大量空转（4 个目标只用 20%），
 * 目标多时触发拒绝→降级→恢复的振荡。这一版反过来：
 * 先算「这一分钟能跑多少次」，再按优先级权重把配额分给每个目标，
 * 间隔是从配额**推出来的**，稳态天然贴着预算跑，不存在超支，也就不需要降级。
 *
 *   可用配额 = 容量 × 85%        （容量 = min(带宽可承受, 官方限速)，gzip 校准后自动变大）
 *   权重     = 档位权重 × 状态系数
 *                档位：高 4 / 中 2 / 低 1（只代表分蛋糕的比重，不再是秒数）
 *                已达标 ×1/3（退位，份额让给未达标的）
 *                距目标 5% 内 ×2（临门一脚盯紧）
 *   间隔     = 60000 × 总权重 ÷ (配额 × 自己的权重)，限幅 [10s, 1800s]
 *
 * 10s 下限：目标太少时 85% 利用率会要求秒级轮询，价格不会秒级变，
 * 纯骚扰官方 API。下限顶住时利用率上不去是健康保护，不是缺陷。
 * 85% 而不是 100%：留配额给手动检查 / 散件对比 / 物品库刷新这些插队请求。
 *
 * 纯函数式重算，不碰网络、不碰时间，可直接单测（scripts/test-budget.js）。
 */

const TIER_WEIGHT = { high: 4, normal: 2, low: 1 };
const UTIL = 0.85; // 稳态预算利用率目标
const MIN_MS = 10 * 1000;
const MAX_MS = 1800 * 1000;
const FALLBACK_MS = 60 * 1000;
/**
 * 容量硬顶：官方文档明示 3 req/s，340ms 间隔 = 176 次/分。
 * 超过就是滥用级用法，会提高被 Cloudflare 盯上的概率——出界即 ban 的边界。
 */
const MAX_CAPACITY = 176;
const MIN_CAPACITY = 20; // 持久化恢复的下限（用户约定）

/**
 * 持久化恢复：上次会话收敛的容量存在配置里，本次启动用「配置值 − 10」起步，
 * 省掉 300→87 的冷启动校准过程（约一分钟）。
 *
 * 安全闸门（任何一条不过 → 返回 null，回归 20 冷启动）：
 * - storedCapacity 出界（<20 或 >176）：说明上次数据异常
 * - storedAvgKb 出界（<20 或 >800 KB）：同上
 * - 配置值 −10 超过「按上次实测体积算出的带宽容量」或限速上限：
 *   说明这套配置在当前网络条件下撑不住，宁可冷启动重新校准
 *
 * @returns {{ avgKb: number, capacity: number } | null} avgKb 供 EWMA 从保守值起步
 */
function resumeCapacity({ storedCapacity, storedAvgKb, bandwidthKbPerMin, minRequestIntervalMs } = {}) {
  const stored = Number(storedCapacity) || 0;
  const storedKb = Number(storedAvgKb) || 0;
  if (stored < MIN_CAPACITY || stored > MAX_CAPACITY) return null;
  if (storedKb < 20 || storedKb > 800) return null;
  const bw = Number(bandwidthKbPerMin) || 6000;
  const rateCap = Math.floor(60000 / Math.max(340, Number(minRequestIntervalMs) || 500));
  const bwCap = Math.floor(bw / storedKb); // 用上次实测体积算出的带宽容量
  // 「配置值 − 10，下限 20」；带宽/限速撑不住时钳到能承受的最大值（与冷启动等价）
  const initial = Math.min(Math.max(stored - 10, MIN_CAPACITY), bwCap, rateCap, MAX_CAPACITY);
  if (initial < MIN_CAPACITY) return null;
  // avgKb 反推成 initial 对应的体积，让 configure 恰好得出 initial；EWMA 之后自行演进
  return { avgKb: bw / initial, capacity: initial };
}

class FairShare {
  constructor() {
    this.capacity = 20; // 每分钟允许的检查次数（由 configure 推导）
    this.intervals = new Map(); // targetId -> 分配到的间隔 ms
    this.lastPlan = null; // 最近一次重算的快照，供 UI 展示
  }

  /** 容量推导与旧版一致：min(带宽, 限速)，下限保护。返回容量供测试断言 */
  configure({ bandwidthKbPerMin, avgKbPerCheck, minChecksPerMin, minRequestIntervalMs } = {}) {
    const rateCap = Math.floor(60000 / Math.max(340, Number(minRequestIntervalMs) || 500));
    const bwCap = Math.floor((Number(bandwidthKbPerMin) || 6000) / Math.max(20, Number(avgKbPerCheck) || 300));
    this.capacity = Math.max(Number(minChecksPerMin) || 6, Math.min(bwCap, rateCap, MAX_CAPACITY));
    return this.capacity;
  }

  /**
   * 全量重算。任何「能改变间隔」的事发生后调用：目标增删、达标状态翻转、
   * 容量校准（30s 周期）、设置变更。重算不重排已排定的 nextRunAt——
   * 间隔在下一次调度时自然生效，避免所有目标同时跳变。
   *
   * @param {Array} list  [{ id, priority, matched, near }]
   */
  recompute(list) {
    const active = (list || []).filter((t) => t && t.id);
    if (!active.length) {
      this.intervals.clear();
      this.lastPlan = { capacity: this.capacity, quota: 0, totalWeight: 0, items: [] };
      return this.lastPlan;
    }
    const weightOf = (t) => {
      const tier = TIER_WEIGHT[t.priority] || TIER_WEIGHT.normal;
      const state = t.matched ? 1 / 3 : t.near ? 2 : 1;
      return tier * state;
    };
    const ws = active.map(weightOf);
    const totalW = ws.reduce((a, b) => a + b, 0) || 1;
    const quota = this.capacity * UTIL; // 每分钟实际打算跑的次数
    const items = [];
    active.forEach((t, i) => {
      const ms = clamp((60000 * totalW) / (quota * ws[i]), MIN_MS, MAX_MS);
      this.intervals.set(t.id, ms);
      items.push({ id: t.id, priority: t.priority, weight: round2(ws[i]), intervalSec: Math.round(ms / 1000) });
    });
    this.lastPlan = { capacity: this.capacity, quota: round2(quota), totalWeight: round2(totalW), items };
    return this.lastPlan;
  }

  /** 单目标间隔。未参与过重算的目标（刚添加）回退 60s，等下一轮重算 */
  intervalOf(id) {
    return this.intervals.get(id) || FALLBACK_MS;
  }

  remove(id) {
    this.intervals.delete(id);
  }

  /** 供设置页显示：容量 / 计划用量 / 实际利用率 */
  snapshot(actualPerMin) {
    const plan = this.lastPlan || { capacity: this.capacity, quota: 0, totalWeight: 0, items: [] };
    const plannedPerMin = plan.items.reduce((a, i) => a + 60000 / (i.intervalSec * 1000), 0);
    return {
      capacity: this.capacity,
      quota: plan.quota,
      plannedPerMin: round2(plannedPerMin),
      utilization: plan.capacity ? round2(Math.min(1, (Number(actualPerMin) || plan.quota) / plan.capacity)) : 0,
      items: plan.items,
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = { FairShare, TIER_WEIGHT, UTIL, MIN_MS, MAX_MS, MAX_CAPACITY, MIN_CAPACITY, resumeCapacity };
