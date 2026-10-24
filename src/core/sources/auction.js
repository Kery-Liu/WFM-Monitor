'use strict';

/**
 * 数据源层 - 紫卡拍卖
 * 说明：拍卖接口仍在 v1（/v1/auctions/search），已验证支持
 *   type / weapon_url_name / positive_stats / negative_stats / polarity / sort_by
 * 但「一口价上限」「排除重复」等逻辑接口不支持，故在本地过滤（rules.snapshotAuction）。
 */

class AuctionSource {
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
  }

  buildQuery(target) {
    const qs = new URLSearchParams();
    qs.set('type', 'riven');
    if (target.weaponSlug) qs.set('weapon_url_name', target.weaponSlug);
    for (const s of target.positiveStats || []) qs.append('positive_stats', s);
    for (const s of target.negativeStats || []) qs.append('negative_stats', s);
    if (target.polarity) qs.set('polarity', target.polarity);
    qs.set('sort_by', 'price_asc');
    return qs.toString();
  }

  async search(target) {
    const q = this.buildQuery(target);
    const res = await this.client.request(`/v1/auctions/search?${q}`, {
      priority: 5,
      label: `搜索 ${target.weaponSlug || '紫卡'} 拍卖`,
    });
    const list = res.json?.payload?.auctions;
    if (!Array.isArray(list)) {
      const e = new Error('拍卖响应结构异常');
      e.code = 'SCHEMA';
      throw e;
    }
    return list;
  }

  /** 最新拍卖流（全局，用于补充/发现） */
  async latest() {
    const res = await this.client.request('/v1/auctions?type=riven', { priority: 9 });
    return res.json?.payload?.auctions || [];
  }
}

module.exports = { AuctionSource };
