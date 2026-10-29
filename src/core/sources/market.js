'use strict';

/**
 * 数据源层 - 市场订单
 * 只调用官方 v2 REST，不触碰网页 HTML（这是绕开 Cloudflare 人机验证的关键）
 */

class MarketSource {
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
    this.statsCache = new Map(); // slug -> { ts, series }
  }

  /** 某物品全部订单（含 buy/sell、含离线用户） */
  async fetchOrders(slug) {
    const res = await this.client.request(`/v2/orders/item/${encodeURIComponent(slug)}`, {
      priority: 5,
      label: `获取 ${slug} 订单`,
    });
    if (!res.json || !Array.isArray(res.json.data)) {
      const e = new Error('订单响应结构异常');
      e.code = 'SCHEMA';
      throw e;
    }
    return res.json.data;
  }

  /** 仅在线用户的头部订单，用于快速校验 */
  async fetchTop(slug, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    const suffix = qs.toString() ? `?${qs}` : '';
    const res = await this.client.request(`/v2/orders/item/${encodeURIComponent(slug)}/top${suffix}`, { priority: 6 });
    return res.json?.data || { sell: [], buy: [] };
  }

  /**
   * 48 小时 + 90 天成交统计
   * 官方同一个响应里就带 statistics_closed['48hours'] 和 ['90days']，
   * 一次请求两用：走势图看短期波动，90 天数据算历史分位与推荐价区间。
   * 带 5 分钟缓存。
   */
  async fetchStats(slug, ttlMs = 300000) {
    const hit = this.statsCache.get(slug);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
    const res = await this.client.request(`/v1/items/${encodeURIComponent(slug)}/statistics`, { priority: 8, label: `获取 ${slug} 统计` });
    const closed = res.json?.payload?.statistics_closed || {};
    const mapRow = (d) => ({
      t: Date.parse(d.datetime),
      median: d.median ?? d.avg_price ?? null,
      min: d.min_price ?? null,
      max: d.max_price ?? null,
      wa: d.wa_price ?? null,
      volume: d.volume ?? 0,
    });
    const pick = (key) =>
      (closed[key] || [])
        .map(mapRow)
        .filter((d) => Number.isFinite(d.t) && d.median != null);
    const data = { h48: pick('48hours'), d90: pick('90days') };
    this.statsCache.set(slug, { ts: Date.now(), data });
    return data;
  }
}

module.exports = { MarketSource };
