'use strict';

/**
 * 领域层 - 套装散件对比
 * 输入：套装散件清单 + 每件的原始挂单
 * 输出：可直接渲染的对比行 + 汇总（整套价 / 散件合计 / 差额）
 *
 * 纯函数，不碰网络。取数在 core/app.js 的 partsCompare 里做。
 */

const { snapshotMarket } = require('./rules');

/**
 * @param {Array} parts             [{ slug, zh, en }]
 * @param {object} ordersBySlug     slug -> 订单数组，或 { error }
 * @param {object} opts             { buyerFilter, perPart }
 */
function buildCompare(parts, ordersBySlug, opts = {}) {
  const buyerFilter = opts.buyerFilter || 'ingame';
  const perPart = Math.max(1, Math.min(10, Number(opts.perPart) || 3));

  return (parts || []).map((p) => {
    const raw = ordersBySlug ? ordersBySlug[p.slug] : null;
    if (!raw || raw.error || !Array.isArray(raw)) {
      return {
        slug: p.slug,
        zh: p.zh || p.slug,
        en: p.en || p.slug,
        bestPrice: null,
        top: [],
        totalEligible: 0,
        error: (raw && raw.error) || 'no-data',
      };
    }
    const snap = snapshotMarket(raw, {
      kind: 'market',
      direction: 'buy',
      targetPrice: 0,
      buyerFilter,
      minQuantity: 1,
    });
    return {
      slug: p.slug,
      zh: p.zh || p.slug,
      en: p.en || p.slug,
      bestPrice: snap.bestPrice,
      top: (snap.top || []).slice(0, perPart),
      totalEligible: snap.totalEligible || 0,
      error: null,
    };
  });
}

/**
 * 汇总：散件合计 vs 整套价
 * diff > 0 表示散件更贵（买整套更划算），diff < 0 表示散件更便宜。
 */
function summarize(rows, setPrice) {
  const list = rows || [];
  const got = list.filter((r) => !r.error && r.bestPrice != null);
  const partsSum = got.reduce((a, r) => a + r.bestPrice, 0);
  const set = Number.isFinite(Number(setPrice)) && setPrice != null ? Number(setPrice) : null;
  return {
    partsSum: got.length ? partsSum : null,
    setPrice: set,
    diff: set != null && got.length ? partsSum - set : null,
    complete: got.length === list.length && list.length > 0,
    missing: list.length - got.length,
    total: list.length,
  };
}

module.exports = { buildCompare, summarize };
