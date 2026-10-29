'use strict';

/**
 * 领域层 - 规则引擎
 * 输入：数据源返回的原始订单/拍卖列表 + 目标规则
 * 输出：快照（当前最优价、候选订单）+ 是否触发
 *
 * 关键：这里不关心网络，只做纯函数计算，方便单测与复用。
 */

const STATUS_GROUPS = {
  ingame: ['ingame'],
  online: ['ingame', 'online'],
  all: ['ingame', 'online', 'offline'],
};

const { quantile } = require('./stats');

/**
 * 剔除明显离群的挂单价。
 * 实测 all 口径下存在 1p / 99999p 这类钓鱼单，一条就能把「最低价」从 70p 拉到 1p，
 * 让监控、推荐价、实际最低价全部失真。按四分位做双侧裁剪，样本不足 4 条时不动。
 */
function dropOutliers(list, higherIsBetter) {
  if (!list || list.length < 4) return list || [];
  const prices = list.map((o) => Number(o.platinum) || 0).sort((a, b) => a - b);
  const p25 = quantile(prices, 0.25);
  const p75 = quantile(prices, 0.75);
  if (!p25 || !p75) return list;
  if (higherIsBetter) {
    const cap = p75 * 3;
    return list.filter((o) => (Number(o.platinum) || 0) <= cap);
  }
  const floor = p25 * 0.3;
  return list.filter((o) => (Number(o.platinum) || 0) >= floor);
}

function statusAllowed(filter, status) {
  const allowed = STATUS_GROUPS[filter] || STATUS_GROUPS.all;
  return allowed.includes(status || 'offline');
}

function orderPrice(o) {
  return Number(o.platinum) || 0;
}

/** 市场订单快照 */
function snapshotMarket(orders, target) {
  const wantSell = target.direction !== 'sell'; // direction=buy → 我要买 → 看别人 sell
  const type = wantSell ? 'sell' : 'buy';
  const minQty = Math.max(1, Number(target.minQuantity) || 1);

  // 同侧挂单先剔掉离群价，再谈筛选。
  const side = dropOutliers(
    (orders || []).filter((o) => o && o.visible !== false && o.type === type && orderPrice(o) > 0),
    !wantSell
  );

  const eligible = side.filter((o) => {
    if ((Number(o.quantity) || 0) < minQty) return false;
    if (target.rankFilter != null && target.rankFilter !== '' && o.rank != null && Number(o.rank) !== Number(target.rankFilter)) return false;
    if (!statusAllowed(target.buyerFilter, o.user && o.user.status)) return false;
    return true;
  });

  eligible.sort((a, b) => (wantSell ? orderPrice(a) - orderPrice(b) : orderPrice(b) - orderPrice(a)));

  const best = eligible[0] || null;
  const bestPrice = best ? orderPrice(best) : null;
  const targetPrice = Number(target.targetPrice) || 0;

  let matched = false;
  let delta = null;
  if (bestPrice != null && targetPrice > 0) {
    matched = wantSell ? bestPrice <= targetPrice : bestPrice >= targetPrice;
    delta = wantSell ? targetPrice - bestPrice : bestPrice - targetPrice;
  }

  const atOrBetter = bestPrice == null
    ? []
    : eligible.filter((o) => (wantSell ? orderPrice(o) <= targetPrice : orderPrice(o) >= targetPrice));

  // 全量口径：同样看这一侧，但不套用户的任何筛选（卖家状态 / 最小数量 / 等级）。
  // 用途是告诉用户「外面还有更便宜的，只是被你自己的条件筛掉了」。
  // 实测 Mag Prime Set 最便宜的 8 条卖单全是在离线号，所以这里必须带上状态与更新时间，
  // 否则用户会以为这个价现在就能成交。
  const allSide = side
    .slice()
    .sort((a, b) => (wantSell ? orderPrice(a) - orderPrice(b) : orderPrice(b) - orderPrice(a)));
  const allTop = allSide[0] || null;
  const allPrice = allTop ? orderPrice(allTop) : null;
  const allBetter = bestPrice != null && allPrice != null && (wantSell ? allPrice < bestPrice : allPrice > bestPrice);

  return {
    kind: 'market',
    direction: target.direction,
    bestPrice,
    targetPrice,
    matched,
    delta,
    bestOrder: best ? compactOrder(best) : null,
    top: eligible.slice(0, 10).map(compactOrder),
    countAtTarget: atOrBetter.length,
    totalEligible: eligible.length,
    allBest: allBetter ? { price: allPrice, order: compactOrder(allTop) } : null,
    ts: Date.now(),
  };
}

function compactOrder(o) {
  return {
    id: o.id,
    type: o.type,
    platinum: orderPrice(o),
    quantity: o.quantity,
    rank: o.rank ?? null,
    perTrade: o.perTrade ?? null,
    updatedAt: o.updatedAt || null,
    user: {
      name: o.user?.ingameName || '',
      slug: o.user?.slug || '',
      status: o.user?.status || 'offline',
      reputation: o.user?.reputation ?? null,
      platform: o.user?.platform || '',
      // 对方自己用的语言，决定 /w 文案发中文还是英文
      locale: o.user?.locale || '',
    },
  };
}

/** 拍卖快照（紫卡） */
function snapshotAuction(auctions, target) {
  const list = (auctions || []).filter((a) => {
    if (!a) return false;
    if (a.visible === false || a.closed === true) return false;
    if (target.weaponSlug && a.item?.weapon_url_name !== target.weaponSlug) return false;
    if (!statusAllowed(target.buyerFilter, a.owner?.status)) return false;
    if (target.maxReRolls != null && target.maxReRolls !== '' && Number(a.item?.re_rolls) > Number(target.maxReRolls)) return false;
    if (target.maxMastery != null && target.maxMastery !== '' && Number(a.item?.mastery_level) > Number(target.maxMastery)) return false;
    if (target.polarity && a.item?.polarity && a.item.polarity !== target.polarity) return false;

    const pos = (a.item?.attributes || []).filter((x) => x.positive).map((x) => x.url_name);
    const neg = (a.item?.attributes || []).filter((x) => !x.positive).map((x) => x.url_name);
    if (target.positiveStats?.length && !target.positiveStats.every((s) => pos.includes(s))) return false;
    if (target.negativeStats?.length && !target.negativeStats.some((s) => neg.includes(s))) return false;
    return true;
  });

  const priceOf = (a) => {
    const mode = target.auctionMode || 'buyout';
    if (mode === 'bid') return Number(a.top_bid?.platinum ?? a.starting_price ?? a.buyout_price ?? 0);
    return Number(a.buyout_price ?? 0);
  };

  const priced = list
    .map((a) => ({ a, price: priceOf(a) }))
    .filter((x) => x.price > 0)
    .sort((x, y) => x.price - y.price);

  const targetPrice = Number(target.targetPrice) || 0;
  const best = priced[0] || null;
  const bestPrice = best ? best.price : null;
  const matched = bestPrice != null && targetPrice > 0 && bestPrice <= targetPrice;

  return {
    kind: 'auction',
    direction: 'buy',
    bestPrice,
    targetPrice,
    matched,
    // 和挂单口径一致：正数=优于目标，负数=还差多少；不能只在达标时才有值
    delta: bestPrice != null && targetPrice > 0 ? targetPrice - bestPrice : null,
    bestOrder: best ? compactAuction(best.a, best.price) : null,
    top: priced.slice(0, 10).map((x) => compactAuction(x.a, x.price)),
    countAtTarget: priced.filter((x) => x.price <= targetPrice).length,
    totalEligible: priced.length,
    ts: Date.now(),
  };
}

function compactAuction(a, price) {
  return {
    id: a.id,
    platinum: price,
    buyout: a.buyout_price ?? null,
    starting: a.starting_price ?? null,
    topBid: a.top_bid?.platinum ?? null,
    created: a.created || null,
    note: a.note || '',
    reRolls: a.item?.re_rolls ?? null,
    mastery: a.item?.mastery_level ?? null,
    polarity: a.item?.polarity || null,
    rivenName: a.item?.name || '',
    weaponSlug: a.item?.weapon_url_name || '',
    attributes: (a.item?.attributes || []).map((x) => ({ url_name: x.url_name, value: x.value, positive: x.positive })),
    user: {
      name: a.owner?.ingame_name || '',
      slug: a.owner?.slug || '',
      status: a.owner?.status || 'offline',
      reputation: a.owner?.reputation ?? null,
      locale: a.owner?.locale || '',
    },
  };
}

/** 统一的 snapshot 入口 */
function snapshotFor(target, raw) {
  return target.kind === 'auction' ? snapshotAuction(raw, target) : snapshotMarket(raw, target);
}

/** 校验并规范化用户提交的目标 */
function sanitizeTarget(input) {
  const t = { ...input };
  t.kind = t.kind === 'auction' ? 'auction' : 'market';
  t.direction = t.direction === 'sell' ? 'sell' : 'buy';
  t.targetPrice = Math.max(0, Number(t.targetPrice) || 0);
  t.buyerFilter = STATUS_GROUPS[t.buyerFilter] ? t.buyerFilter : 'all';
  t.minQuantity = Math.max(1, Number(t.minQuantity) || 1);
  t.intervalSec = Math.min(3600, Math.max(10, Number(t.intervalSec) || 60));
  t.enabled = t.enabled !== false;
  t.confirmRounds = Math.min(10, Math.max(1, Number(t.confirmRounds) || 1));
  if (t.kind === 'auction') {
    t.auctionMode = t.auctionMode === 'bid' ? 'bid' : 'buyout';
    t.positiveStats = Array.isArray(t.positiveStats) ? t.positiveStats.filter(Boolean).slice(0, 4) : [];
    t.negativeStats = Array.isArray(t.negativeStats) ? t.negativeStats.filter(Boolean).slice(0, 4) : [];
    t.polarity = t.polarity || null;
    t.maxReRolls = t.maxReRolls === '' || t.maxReRolls == null ? null : Math.max(0, Number(t.maxReRolls));
    t.maxMastery = t.maxMastery === '' || t.maxMastery == null ? null : Math.max(0, Number(t.maxMastery));
  }
  return t;
}

module.exports = { snapshotFor, snapshotMarket, snapshotAuction, sanitizeTarget, statusAllowed, STATUS_GROUPS };
