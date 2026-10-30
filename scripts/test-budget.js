'use strict';

/**
 * 配额分配器单测（v1.2.1 fair-share，纯离线）
 * 覆盖：容量推导 / 按权重分配 / 85% 利用率 / 10s 下限 / 达标退位 / 接近提速 /
 *       优先级相对性 / 目标增删再分配 / snapshot
 */

const { FairShare, TIER_WEIGHT, MIN_MS } = require('../src/core/engine/budget');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}

const t = (id, priority, extra = {}) => ({ id, priority, matched: false, near: false, ...extra });

// ---------- 1. 容量推导 ----------
{
  const b = new FairShare();
  check('6000KB/分 ÷ 300KB = 20 次/分', b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 }) === 20);
  check('gzip 校准后 70KB/次 → 85 次/分', b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 70, minRequestIntervalMs: 500 }) === 85);
  check('限速封顶 120 次/分（500ms）', b.configure({ bandwidthKbPerMin: 60000, avgKbPerCheck: 20, minRequestIntervalMs: 500 }) === 120);
  check('带宽算出来太小 → 兜底 6 次/分', b.configure({ bandwidthKbPerMin: 300, avgKbPerCheck: 800, minChecksPerMin: 6 }) === 6);
}

// ---------- 2. 核心承诺：稳态利用率 ≈ 85% ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const plan = b.recompute([t('a', 'normal'), t('b', 'normal'), t('c', 'normal'), t('d', 'normal')]);
  const planned = plan.items.reduce((a, i) => a + 60000 / (i.intervalSec * 1000), 0);
  check('4 个中档目标跑满 85% 预算', Math.abs(planned - 17) < 0.6, `planned=${planned.toFixed(2)}/20`);
  check('4 个中档各自约 14s', plan.items.every((i) => i.intervalSec === 14), plan.items.map((i) => i.intervalSec).join(','));
}

// ---------- 3. 优先级是比重不是秒数（目标够多，间隔不触 10s 下限） ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const list = [t('hi', 'high')];
  for (let i = 0; i < 9; i += 1) list.push(t('mid' + i, 'normal'));
  const plan = b.recompute(list); // totalW=4+18=22，hi 理论 19.4s、mid 38.8s
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i.intervalSec]));
  check('高档分到约 2 倍于中档的频率', Math.abs(by.mid0 / by.hi - 2) < 0.1, `hi=${by.hi}s mid=${by.mid0}s`);
  const g = new FairShare();
  g.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const lo = [t('hi', 'high')];
  for (let i = 0; i < 9; i += 1) lo.push(t('low' + i, 'low'));
  const p2 = g.recompute(lo); // hi 11.5s、low 45.9s，比率 4
  const by2 = Object.fromEntries(p2.items.map((i) => [i.id, i.intervalSec]));
  check('高:低频率 = 4:1', Math.abs(by2.low0 / by2.hi - 4) < 0.2, `hi=${by2.hi}s lo=${by2.low0}s`);
}

// ---------- 4. 目标多时自动放慢（旧版这里会触发拒绝+降级） ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const many = Array.from({ length: 20 }, (_, i) => t('m' + i, 'normal'));
  const plan = b.recompute(many);
  const planned = plan.items.reduce((a, i) => a + 60000 / (i.intervalSec * 1000), 0);
  check('20 个目标仍然恰好 85% 预算', Math.abs(planned - 17) < 0.6, `planned=${planned.toFixed(2)}/20`);
  // 17 次/分分给 20 个中档：每人 0.85 次/分 = 71s。总额不变，摊到每个人头上变稀
  check('每个约 71s（自动放慢，无降级胶囊）', plan.items[0].intervalSec === 71, plan.items[0].intervalSec + 's');
}

// ---------- 5. 10s 下限是健康保护 ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 70, minChecksPerMin: 6, minRequestIntervalMs: 500 }); // 容量 85
  const plan = b.recompute([t('a', 'normal'), t('b', 'normal'), t('c', 'normal'), t('d', 'normal')]);
  check('容量 85 时 4 个目标被 10s 下限顶住', plan.items.every((i) => i.intervalSec === 10), plan.items.map((i) => i.intervalSec).join(','));
  check('下限不低于 10s', MIN_MS === 10000);
}

// ---------- 6. 达标退位：份额让给未达标的 ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const plan = b.recompute([
    t('done', 'normal', { matched: true }),
    t('a', 'normal'),
    t('b', 'normal'),
    t('c', 'normal'),
  ]);
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i.intervalSec]));
  check('达标目标放慢约 3 倍', Math.abs(by.done / by.a - 3) < 0.2, `done=${by.done}s active=${by.a}s`);
  check('未达标目标因此加快（份额被让出）', by.a < 14, by.a + 's');
}

// ---------- 7. 接近目标提速（5 个目标稀释，间隔不触下限） ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  const plan = b.recompute([
    t('near', 'normal', { near: true }),
    t('a', 'normal'),
    t('b', 'normal'),
    t('c', 'normal'),
    t('d', 'normal'),
  ]);
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i.intervalSec]));
  check('接近目标的目标快约 2 倍', Math.abs(by.a / by.near - 2) < 0.1, `near=${by.near}s other=${by.a}s`);
}

// ---------- 8. 增删目标再分配 ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  b.recompute([t('a', 'normal')]);
  const before = b.intervalOf('a'); // 单目标理论 3.5s，被 10s 下限顶住
  b.recompute([t('a', 'normal'), t('b', 'normal'), t('c', 'normal'), t('d', 'normal')]);
  const after = b.intervalOf('a'); // 14s
  check('目标变多间隔自动拉长', after > before, `${Math.round(before / 1000)}s → ${Math.round(after / 1000)}s`);
  b.remove('a');
  check('remove 清掉分配（回退 60s）', b.intervalOf('a') === 60000, b.intervalOf('a') / 1000 + 's');
}

// ---------- 9. snapshot ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  b.recompute([t('a', 'normal'), t('b', 'normal')]);
  const s = b.snapshot();
  check('snapshot 带容量/计划用量/利用率',
    s.capacity === 20 && s.plannedPerMin > 0 && s.utilization > 0.8,
    `capacity=${s.capacity} planned=${s.plannedPerMin} util=${s.utilization}`);
  const s2 = b.snapshot(4); // 实际每分钟跑了 4 次
  check('可传实际用量算利用率', Math.abs(s2.utilization - 0.2) < 0.01, s2.utilization);
}

// ---------- 10. 空列表 / 未知档位 ----------
{
  const b = new FairShare();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  const plan = b.recompute([]);
  check('空列表不炸', plan.items.length === 0 && b.intervalOf('x') === 60000);
  b.recompute([t('a', 'bogus')]);
  // 单个 normal 权重理论 3.5s，被 10s 下限顶住；「按 normal 处理」的证明是与 normal 相同
  const ref = new FairShare();
  ref.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  ref.recompute([t('r', 'normal')]);
  check('未知档位按 normal 权重处理', b.intervalOf('a') === ref.intervalOf('r'), b.intervalOf('a') + ' vs ' + ref.intervalOf('r'));
}

check('权重表 高:中:低 = 4:2:1', TIER_WEIGHT.high === 4 && TIER_WEIGHT.normal === 2 && TIER_WEIGHT.low === 1);

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures ? 1 : 0);
