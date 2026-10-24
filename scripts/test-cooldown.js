'use strict';

/**
 * 冷却持久化验证：
 * 第一次运行触发通知 → 立即重启 → 第二次运行不应再通知（冷却仍在）
 */

const path = require('path');
const fs = require('fs');
const { App } = require('../src/core/app');

const dataDir = path.join(__dirname, '..', '_tmp', 'udata-cd');
const target = {
  kind: 'market',
  slug: 'ash_prime_set',
  direction: 'buy',
  targetPrice: 200,
  buyerFilter: 'all',
  intervalSec: 600,
  confirmRounds: 1,
};

async function runOnce(label) {
  const sent = [];
  const app = new App({ dataDir, hooks: { showDesktop: async (p) => sent.push(p.title) } });
  await app.init();
  const existing = app.targets()[0];
  const t = existing ? existing.target : await app.addTarget(target);
  const m = app.scheduler.getMonitor(t.id);
  m.requestNow();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (m.snapshot) break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  console.log(`${label}: bestPrice=${m.snapshot?.bestPrice} 通知数=${sent.length}`);
  await app.shutdown();
  return sent.length;
}

(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), path.join(dataDir, 'catalog.json'));

  const first = await runOnce('第一次启动');
  const second = await runOnce('重启后');
  const rt = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
  console.log('runtime.json:', JSON.stringify(rt).slice(0, 160));
  const ok = first === 1 && second === 0;
  console.log(ok ? '\n✅ 冷却状态跨重启生效' : '\n❌ 冷却没有跨重启保留');
  process.exit(ok ? 0 : 1);
})();
