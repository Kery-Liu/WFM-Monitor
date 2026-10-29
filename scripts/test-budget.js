'use strict';

/**
 * 全局预算分配器单测（纯离线，不启 Electron、不发请求）
 * 覆盖：容量推导 / 优先级排序 / 降级与恢复 / 手动绕过 / 不饿死 / 关闭自动调度
 */

const { BudgetAllocator, TIER_MS } = require('../src/core/engine/budget');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}

/** 造一个够 pick() 用的假 monitor */
const mon = (id, priority, at, failures = 0) => ({
  id,
  target: { priority },
  nextRunAt: at,
  failures,
  forceRun: false,
});

const T0 = Date.now();

// ---------- 1. 容量推导 ----------
{
  const b = new BudgetAllocator();
  const cap = b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  check('6000KB/分 ÷ 300KB = 20 次/分', cap === 20, cap);

  const capGz = b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 70, minRequestIntervalMs: 500 });
  check('gzip 后 70KB/次 → 80+ 次/分', capGz >= 80 && capGz <= 86, capGz);

  const capRate = b.configure({ bandwidthKbPerMin: 60000, avgKbPerCheck: 20, minRequestIntervalMs: 500 });
  check('限速封顶 120 次/分（500ms）', capRate === 120, capRate);

  const capRate340 = b.configure({ bandwidthKbPerMin: 60000, avgKbPerCheck: 20, minRequestIntervalMs: 340 });
  check('限速封顶 176 次/分（340ms）', capRate340 === 176, capRate340);

  const capMin = b.configure({ bandwidthKbPerMin: 300, avgKbPerCheck: 800, minChecksPerMin: 6 });
  check('带宽算出来太小 → 兜底 6 次/分', capMin === 6, capMin);
}

// ---------- 2. 优先级排序 ----------
{
  const b = new BudgetAllocator();
  b.configure({ bandwidthKbPerMin: 600000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  b.setTier('lo', 'low');
  b.setTier('hi', 'high');
  b.setTier('mid', 'normal');
  const due = [
    mon('lo', 'low', T0 - 1000),
    mon('mid', 'normal', T0 - 1000),
    mon('hi', 'high', T0 - 1000),
  ];
  b.tokens = 1; // 只够一个
  const got = b.pick(due, { now: T0, slots: 1 });
  check('只有一个名额时高优先级先跑', got.length === 1 && got[0].id === 'hi', got.map((m) => m.id).join(','));
}

// ---------- 3. 同档按逾期程度排序 ----------
{
  const b = new BudgetAllocator();
  b.configure({ bandwidthKbPerMin: 600000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  b.setTier('a', 'normal');
  b.setTier('b', 'normal');
  b.tokens = 1;
  const due = [mon('a', 'normal', T0 - 5000), mon('b', 'normal', T0 - 50000)];
  const got = b.pick(due, { now: T0, slots: 1 });
  check('同档里逾期久的先跑（防饿死）', got[0].id === 'b', got[0].id);
}

// ---------- 4. 令牌耗尽与降级 ----------
{
  const b = new BudgetAllocator();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minChecksPerMin: 6, minRequestIntervalMs: 500 });
  b.tokens = 1;
  b.setTier('x', 'normal');
  const due = [mon('x', 'normal', T0 - 1000)];
  const first = b.pick(due, { now: T0, slots: 2 });
  check('有令牌时放行', first.length === 1, first.length);
  check('放行后令牌归零', b.tokens < 1, b.tokens.toFixed(2));

  const second = b.pick([mon('x', 'normal', T0 - 1000)], { now: T0 + 50, slots: 2 });
  check('令牌耗尽后被拒', second.length === 0, second.length);
  check('被拒一次后 level 仍为 0', b.levelOf('x') === 0, b.levelOf('x'));

  b.pick([mon('x', 'normal', T0 - 1000)], { now: T0 + 100, slots: 2 });
  check('连续被拒 2 次 → level 1（间隔 ×2）', b.levelOf('x') === 1 && b.factorOf('x') === 2, `${b.levelOf('x')}/${b.factorOf('x')}`);

  for (let i = 0; i < 4; i += 1) b.pick([mon('x', 'normal', T0 - 1000)], { now: T0 + 200 + i * 10, slots: 2 });
  check('连续被拒 5 次 → level 2（间隔 ×3）', b.levelOf('x') === 2 && b.factorOf('x') === 3, `${b.levelOf('x')}/${b.factorOf('x')}`);
}

// ---------- 5. 手动触发绕过预算 ----------
{
  const b = new BudgetAllocator();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  b.tokens = 0;
  const manual = { ...mon('m', 'low', T0 - 1000), forceRun: true };
  const got = b.pick([manual], { now: T0, slots: 1 });
  check('令牌为 0 时手动仍能跑', got.length === 1 && got[0].id === 'm', got.length);
  check('手动挡计入 manual 统计', b.stats.manual === 1, b.stats.manual);
}

// ---------- 6. 关闭自动调度时直接切片 ----------
{
  const b = new BudgetAllocator();
  b.configure({ enabled: false, bandwidthKbPerMin: 6000, avgKbPerCheck: 300 });
  b.tokens = 0;
  const due = [mon('a', 'low', T0), mon('b', 'high', T0), mon('c', 'normal', T0)];
  const got = b.pick(due, { now: T0, slots: 2 });
  check('关闭后不做优先级筛选，只按数量截断', got.length === 2, got.map((m) => m.id).join(','));
}

// ---------- 7. 窗口结算：安静窗口才回落 ----------
{
  const b = new BudgetAllocator({ windowMs: 60000 });
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  b.setTier('y', 'normal');
  b.tokens = 0;
  // 造两次拒绝 → level 1
  b.pick([mon('y', 'normal', T0)], { now: T0, slots: 1 });
  b.pick([mon('y', 'normal', T0)], { now: T0 + 10, slots: 1 });
  const lv1 = b.levelOf('y');

  // 第一次跨窗口：上一窗口有拒绝 → 不回落，只清零计数
  b.tokens = b.capacity;
  b.pick([mon('y', 'normal', T0)], { now: T0 + 70000, slots: 1 });
  const afterBusy = b.levelOf('y');

  // 第二次跨窗口：这一窗口没被拒过 → 回落一级
  b.tokens = b.capacity;
  b.pick([mon('y', 'normal', T0)], { now: T0 + 140000, slots: 1 });
  check('有拒绝的窗口不回落', lv1 === 1 && afterBusy === 1, `${lv1} → ${afterBusy}`);
  check('安静窗口后降级回落一级', lv1 === 1 && b.levelOf('y') === 0, `${lv1} → ${b.levelOf('y')}`);
}

// ---------- 8. snapshot 结构 ----------
{
  const b = new BudgetAllocator();
  b.configure({ bandwidthKbPerMin: 6000, avgKbPerCheck: 300, minRequestIntervalMs: 500 });
  b.setTier('z', 'normal');
  b.configure({ bandwidthKbPerMin: 3000, avgKbPerCheck: 600 });
  const s = b.snapshot();
  check('snapshot 带容量/用量/降级列表',
    typeof s.capacity === 'number' && typeof s.used === 'number' && Array.isArray(s.degraded),
    JSON.stringify(s).slice(0, 80));
}

// ---------- 9. 档位与基准间隔 ----------
{
  const b = new BudgetAllocator();
  b.setTier('h', 'high');
  b.setTier('n', 'normal');
  b.setTier('l', 'low');
  check('档位映射到 20/60/180 秒',
    b.baseMsOf('h') === TIER_MS.high && b.baseMsOf('n') === TIER_MS.normal && b.baseMsOf('l') === TIER_MS.low,
    [b.baseMsOf('h'), b.baseMsOf('n'), b.baseMsOf('l')].join('/'));
  check('未登记的 id 按 normal 处理', b.baseMsOf('unknown') === TIER_MS.normal);
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures ? 1 : 0);
