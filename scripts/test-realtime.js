'use strict';

/** 实时流分发链路验证：注入一条假订单，看是否立刻触发第二封通知 */

const path = require('path');
const fs = require('fs');
const { App } = require('../src/core/app');

const dataDir = path.join(__dirname, '..', '_tmp', 'udata-rt');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), path.join(dataDir, 'catalog.json'));

const sent = [];

(async () => {
  const app = new App({
    dataDir,
    hooks: {
      showDesktop: async (p) => {
        sent.push(p.title);
        console.log('  [桌面通知]', p.title);
      },
    },
  });
  await app.init();
  app.saveSettings({ notify: { cooldownSec: 0 } });

  const t = await app.addTarget({
    kind: 'market',
    slug: 'ash_prime_set',
    direction: 'buy',
    targetPrice: 200,
    buyerFilter: 'all',
    intervalSec: 600,
    confirmRounds: 1,
  });
  console.log('target added:', t.id);

  // 等首轮检查完成
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const m = app.scheduler.getMonitor(t.id);
    if (m && m.snapshot) break;
  }
  const m = app.scheduler.getMonitor(t.id);
  console.log('首轮快照 bestPrice =', m.snapshot && m.snapshot.bestPrice, '| 通知数 =', sent.length);

  // 注入一条更便宜的订单（模拟 WebSocket 推送）。
  // 两个坑：
  //   1) 不能随手写 3p——3p 的 Ash Prime Set 在真实市场不存在，会被 rules.js 的离群过滤剔除；
  //   2) 必须跌够 improveDelta(5p) 才会突破冷却——降 5p 正好卡在「严格小于」的边界上不触发。
  // 所以取「首轮最低价 - 10」，既跨过阈值又落在合理价格区间内。
  const base = (m.snapshot && m.snapshot.bestPrice) || 100;
  const cheap = Math.max(25, base - 10);
  const fake = {
    id: 'fake_order_1',
    type: 'sell',
    platinum: cheap,
    quantity: 1,
    perTrade: 1,
    visible: true,
    itemId: t.itemId,
    updatedAt: new Date().toISOString(),
    user: { ingameName: 'TESTER', slug: 'tester', status: 'ingame', reputation: 99, platform: 'pc' },
  };
  console.log(`注入实时订单 ${cheap}p …`);
  await m.applyRealtime(fake);
  await new Promise((r) => setTimeout(r, 800));

  console.log('注入后 bestPrice =', m.snapshot && m.snapshot.bestPrice, '| 通知数 =', sent.length);
  const evs = app.events(5);
  console.log('事件条数:', evs.length);
  if (evs[0]) console.log('最近事件:', evs[0].price, 'p |', evs[0].targetLabel);

  const okCheap = m.snapshot.bestPrice === cheap && sent.length >= 2 && evs[0] && evs[0].price === cheap;

  // 再注入一条 1p 的钓鱼单：应被离群过滤剔除，最优价与通知数都不该变。
  const sentBefore = sent.length;
  console.log('注入 1p 钓鱼单 …');
  await m.applyRealtime({ ...fake, id: 'fake_order_2', platinum: 1 });
  await new Promise((r) => setTimeout(r, 600));
  const okJunk = m.snapshot.bestPrice === cheap && sent.length === sentBefore;
  console.log('钓鱼单后 bestPrice =', m.snapshot.bestPrice, '| 通知数 =', sent.length, '（应保持不变）');

  const ok = okCheap && okJunk;
  if (!okCheap) console.log('  ✗ 更便宜的真实订单未生效');
  if (!okJunk) console.log('  ✗ 1p 钓鱼单未被离群过滤拦住');
  console.log(ok ? '\n✅ 实时链路通过' : '\n❌ 实时链路异常');
  await app.shutdown();
  process.exit(ok ? 0 : 1);
})();
