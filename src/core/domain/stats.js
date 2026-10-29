'use strict';

/**
 * 领域层 - 价格统计
 * 输入：官方 statistics 的 statistics_closed 序列（日线 / 小时线）
 * 输出：分位数、等待天数、推荐目标价区间、分位摘要
 *
 * 纯函数，不碰网络也不碰配置，方便单测。
 *
 * 口径说明（实测得来，别随手改）：
 *   推荐价用日线 min_price（当日成交最低价），不用 wa_price（成交加权均价）。
 *   wa_price 是「已成交」的均价，而当前最低价是「还没成交」的挂单；
 *   挂单先降价再成交，拿两者直接比会系统性判成「当前是历史低位」。
 *   实测 4 个物品里 3 个都被 wa_price 误判，换成 min_price 后输出才对得上。
 */

/** 有序数组的线性插值分位数，p ∈ [0,1] */
function quantile(values, p) {
  const arr = (values || [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  const pos = Math.min(1, Math.max(0, Number(p) || 0)) * (arr.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/** x 在 values 里的分位（0-100）：有百分之多少的样本 ≤ x */
function percentileOf(values, x) {
  const arr = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!arr.length || !Number.isFinite(x)) return null;
  const below = arr.filter((v) => v <= x).length;
  return Math.round((below / arr.length) * 100);
}

/**
 * 设目标价 x，平均要等几天。
 * 日线每条代表一天，所以「len 天里有 hits 天到过这个价」→ 平均 len/hits 天一次。
 */
function waitDays(lows, x) {
  const arr = (lows || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!arr.length || !Number.isFinite(x)) return null;
  const hits = arr.filter((v) => v <= x).length;
  if (!hits) return null;
  return +(arr.length / hits).toFixed(1);
}

/** 90 天日线摘要：样本天数、成交量、价格区间、带宽判定用不到但也一并给出 */
function summarize90(d90) {
  const days = (d90 || []).filter((d) => d && d.volume > 0 && Number.isFinite(d.min));
  if (!days.length) {
    return { samples: 0, dailyVolume: 0, low: null, high: null, median: null };
  }
  const lows = days.map((d) => d.min);
  const highs = days.map((d) => d.max ?? d.median);
  const medians = days.map((d) => d.median);
  const volume = days.reduce((a, d) => a + (d.volume || 0), 0);
  return {
    samples: days.length,
    dailyVolume: +(volume / days.length).toFixed(1),
    // 去掉两端极端值，避免一个异常单把区间撑爆
    low: quantile(lows, 0.1),
    high: quantile(highs, 0.9),
    median: quantile(medians, 0.5),
  };
}

const MIN_SAMPLES = 10; // 有成交的日线少于这个数，分位数不可信
const MIN_DAILY_VOL = 1; // 近 7 天日均成交低于 1 单，样本同样不可信

/**
 * 推荐目标价区间
 *
 * 语义：给定一个目标价，用户实际是在问「设这个价，大概多久能等到」。
 * 所以先取 90 天每日最低价的两个分位（P20 = 约 5 天一次，P40 = 约 2.5 天一次），
 * 再用「当前还能不能立刻买到」收敛上限——上限不该高于当前可成交价。
 *
 * @param {object} p
 * @param {Array}  p.d90        90 天日线
 * @param {number} p.cur        当前符合「仅游戏中」的最低卖价，可空
 * @param {number} p.v7         近 7 天日均成交量
 * @param {string} p.kind       'market' | 'auction'
 * @param {boolean} p.isRanked  该物品是否分等级（MOD / 紫卡），分等级时历史价混统，只给参考
 */
function recommendBand({ d90, cur, v7, kind, isRanked } = {}) {
  if (kind === 'auction') return { locked: true, reason: 'auction' };

  const days = (d90 || []).filter((d) => d && d.volume > 0 && Number.isFinite(d.min));
  if (days.length < MIN_SAMPLES) {
    return { locked: true, reason: 'insufficient', samples: days.length };
  }
  const daily = Number(v7) || 0;
  if (daily < MIN_DAILY_VOL) {
    return { locked: true, reason: 'insufficient', samples: days.length, v7: +daily.toFixed(1) };
  }

  const lows = days.map((d) => d.min);
  let lo = quantile(lows, 0.2);
  let hi = quantile(lows, 0.4);
  if (lo == null || hi == null) {
    return { locked: true, reason: 'insufficient', samples: days.length };
  }
  lo = Math.round(lo);
  hi = Math.round(hi);

  // 与当前可成交价收敛：等不到的价格没有意义
  const now = Number(cur);
  if (Number.isFinite(now) && now > 0) {
    if (now < hi) hi = Math.round(now);
    if (now < lo) lo = Math.round(now);
  }
  if (hi < lo) hi = lo;
  if (lo < 1) lo = 1;

  return {
    locked: false,
    lo,
    hi,
    single: hi - lo < 2,
    waitLo: waitDays(lows, lo),
    waitHi: waitDays(lows, hi),
    samples: days.length,
    v7: +daily.toFixed(1),
    ranked: !!isRanked,
  };
}

module.exports = { quantile, percentileOf, waitDays, summarize90, recommendBand };
