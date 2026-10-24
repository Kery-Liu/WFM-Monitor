'use strict';

/**
 * 语义验证：停用 / 全局暂停 / 全部检查 / 手动检查 四者的边界
 */

const path = require('path');
const fs = require('fs');
const { App } = require('../src/core/app');

const dataDir = path.join(__dirname, '..', '_tmp', 'udata-disable');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'assets', 'catalog.seed.json'), path.join(dataDir, 'catalog.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

(async () => {
  const app = new App({ dataDir, hooks: { showDesktop: async () => {} } });
  await app.init();
  app.saveSettings({ global: { minRequestIntervalMs: 400, maxConcurrent: 2 } });

  const a = await app.addTarget({ kind: 'market', slug: 'ash_prime_set', direction: 'buy', targetPrice: 1, buyerFilter: 'all', intervalSec: 3600, confirmRounds: 1 });
  const b = await app.addTarget({ kind: 'market', slug: 'mag_prime_set', direction: 'buy', targetPrice: 1, buyerFilter: 'all', intervalSec: 3600, confirmRounds: 1 });

  // 停用 B
  app.updateTarget(b.id, { enabled: false });
  await sleep(300);
  const mb = app.scheduler.getMonitor(b.id);
  check('停用后 nextRunAt 归零', mb.nextRunAt === 0, `nextRunAt=${mb.nextRunAt}`);

  // 等首轮调度过去
  await sleep(9000);
  check('停用目标没有被调度检查', mb.checkCount === 0, `checkCount=${mb.checkCount}`);

  // 全部检查应跳过停用目标
  const r = app.checkAll();
  check('全部检查只启动启用中的目标', r.started === 1 && r.skipped === 1, `started=${r.started} skipped=${r.skipped}`);
  await sleep(6000);
  const ma = app.scheduler.getMonitor(a.id);
  check('启用目标完成检查', ma.checkCount >= 1, `checkCount=${ma.checkCount}`);
  check('停用目标仍未被自动检查', mb.checkCount === 0, `checkCount=${mb.checkCount}`);

  // 手动检查：允许跑一次，但不改变启用状态
  app.checkNow(b.id);
  await sleep(7000);
  check('手动检查对停用目标生效（一次性）', mb.checkCount === 1, `checkCount=${mb.checkCount}`);
  check('手动检查不改变启用状态', app.scheduler.getMonitor(b.id).target.enabled === false);
  check('跑完仍然回到停用态', app.scheduler.getMonitor(b.id).nextRunAt === 0, `nextRunAt=${mb.nextRunAt}`);

  // 全局暂停
  app.saveSettings({ global: { paused: true } });
  app.scheduler.getMonitor(a.id).requestNow();
  await sleep(4000);
  check('全局暂停时状态为 paused', app.scheduler.getMonitor(a.id).state === 'paused', `state=${app.scheduler.getMonitor(a.id).state}`);
  const r2 = app.checkAll();
  check('暂停时全部检查不应启动（由 UI 拦截，核心层仍允许显式调用）', r2.started === 1, `started=${r2.started}`);
  app.saveSettings({ global: { paused: false } });

  await app.shutdown();
  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
