'use strict';

/**
 * v1.0.1 回归：改目标价后差距立即刷新、默认快捷键、Prime 部件图标、配置迁移
 *
 * 全程离线：数据源/通知全部用桩，不联网也能跑。
 *   node scripts/test-update.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Config } = require('../src/core/config');
const { Catalog } = require('../src/core/sources/catalog');
const { Scheduler } = require('../src/core/engine/scheduler');
const { snapshotAuction } = require('../src/core/domain/rules');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `wfm-${tag}-`));

(async () => {
  // ---------- 1. 默认配置：快捷键开箱可用 ----------
  const c1 = new Config(tmp('cfg-default'));
  check('默认启用全局快捷键', c1.get().ui.hotkey.enabled === true);
  check('默认加速键为 Ctrl+Shift+F9', c1.get().ui.hotkey.accelerator === 'CommandOrControl+Shift+F9');
  check('配置结构版本为 2', c1.get().version === 2);

  // ---------- 2. 老配置迁移：v1 的 enabled=false 自动打开 ----------
  const dir2 = tmp('cfg-migrate');
  fs.writeFileSync(
    path.join(dir2, 'settings.json'),
    JSON.stringify({ version: 1, ui: { language: 'zh', hotkey: { enabled: false, accelerator: 'CommandOrControl+Shift+F9' } } })
  );
  const c2 = new Config(dir2);
  check('v1 配置迁移后快捷键启用', c2.get().ui.hotkey.enabled === true);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir2, 'settings.json'), 'utf8'));
  check('迁移结果已落盘', persisted.version === 2 && persisted.ui.hotkey.enabled === true);

  // ---------- 3. Prime 战甲散件图标用 subIcon ----------
  const dir3 = tmp('catalog');
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'catalog.seed.json'), path.join(dir3, 'catalog.json'));
  const catalog = new Catalog({ client: {}, logger: { info() {}, warn() {} }, dataDir: dir3 });
  const thumbOf = (slug) => catalog.thumbFor(catalog.bySlug(slug));
  check('Prime 战甲套装仍用战甲图', /thumbs\/mag_prime_set\./.test(thumbOf('mag_prime_set')));
  check('Prime 机体蓝图用部件图', thumbOf('mag_prime_chassis_blueprint') === 'sub_icons/warframe/prime_chassis_128x128.png');
  check('Prime 系统蓝图用部件图', thumbOf('mag_prime_systems_blueprint') === 'sub_icons/warframe/prime_systems_128x128.png');
  check('Prime 主蓝图用蓝图图标', thumbOf('mag_prime_blueprint') === 'sub_icons/blueprint_128x128.png');
  check('缺图物品回落 subIcon', thumbOf('caliban_prime_blueprint') === 'sub_icons/blueprint_128x128.png');
  check('普通物品仍用 thumb', /thumbs\/trick_mag\./.test(thumbOf('trick_mag')));
  check('unknown 图视为无图', thumbOf('axi_s17_relic') === '');
  const placeholder = path.join(__dirname, '..', 'src', 'web', 'placeholder.svg');
  check('本地占位图存在', fs.existsSync(placeholder) && fs.statSync(placeholder).size > 100);

  // ---------- 4. 改目标价 → 差距立即重算（不等下一轮） ----------
  const orders = [
    { id: 'o1', type: 'sell', platinum: 100, quantity: 1, visible: true, user: { ingameName: 'A', status: 'ingame' } },
    { id: 'o2', type: 'sell', platinum: 130, quantity: 1, visible: true, user: { ingameName: 'B', status: 'ingame' } },
  ];
  let fetches = 0;
  let notified = 0;
  const store = {
    getRuntime: () => null,
    setRuntime() {},
    pushHistory() {},
    getHistory: () => [],
    appendEvent() {},
    flushHistory() {},
    flushRuntime() {},
    flushTargets() {},
    listTargets: () => [],
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const cfg = new Config(tmp('cfg-sched'));
  const scheduler = new Scheduler({
    config: cfg,
    logger,
    store,
    marketSource: { fetchOrders: async () => { fetches += 1; return orders; } },
    auctionSource: { search: async () => [] },
    notifier: { dispatch: async () => { notified += 1; return { results: [] }; } },
    catalog: { attrs: () => [], bySlug: () => null },
  });

  const target = {
    id: 't1',
    kind: 'market',
    slug: 'mag_prime_set',
    direction: 'buy',
    targetPrice: 80,
    buyerFilter: 'all',
    minQuantity: 1,
    intervalSec: 60,
    confirmRounds: 1,
    enabled: true,
  };
  scheduler.addTarget(target);
  const m = scheduler.getMonitor('t1');
  await m.tick();
  check('首轮取数 1 次', fetches === 1, `fetches=${fetches}`);
  check('首轮差距 = -20', m.view().snapshot.delta === -20, `delta=${m.view().snapshot.delta}`);
  check('首轮未达标', m.view().snapshot.matched === false);

  scheduler.updateTarget({ ...target, targetPrice: 120 });
  const v = scheduler.getMonitor('t1').view();
  check('改价后差距立即变 +20', v.snapshot.delta === 20, `delta=${v.snapshot.delta}`);
  check('改价后立即判定达标', v.snapshot.matched === true);
  check('改价后状态变 trigger', v.state === 'trigger', `state=${v.state}`);
  check('改价不重新取数', fetches === 1, `fetches=${fetches}`);
  check('改价不触发通知', notified === 0, `notified=${notified}`);

  scheduler.updateTarget({ ...target, enabled: false, targetPrice: 130 });
  check('停用后状态仍为 disabled', scheduler.getMonitor('t1').state === 'disabled');

  // ---------- 4b. 换监控对象（slug 变了）不能沿用旧缓存 ----------
  scheduler.updateTarget({ ...target, enabled: true, slug: 'ash_prime_set' });
  const mv = scheduler.getMonitor('t1');
  check('换物品后旧快照已清空', mv.snapshot === null);
  check('换物品后旧缓存已清空', mv.rawCache.length === 0);
  check('换物品后立即安排取数', mv.state === 'idle' && mv.nextRunAt > 0, `state=${mv.state} nextRunAt=${mv.nextRunAt}`);

  // ---------- 5. 拍卖差距：未达标也要有值 ----------
  const snap = snapshotAuction(
    [{ id: 'a1', buyout_price: 500, visible: true, closed: false, owner: { ingame_name: 'C', status: 'ingame' }, item: { weapon_url_name: 'kuva_ayanga', attributes: [] } }],
    { kind: 'auction', weaponSlug: 'kuva_ayanga', targetPrice: 400, buyerFilter: 'all', auctionMode: 'buyout' }
  );
  check('拍卖未达标也有差距', snap.delta === -100, `delta=${snap.delta}`);

  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
