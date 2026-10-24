'use strict';

/**
 * 邮件版式 & Webhook 关键词验证
 * 邮件：主题必须点名 warframe.market + 物品 + 价格；正文含完整快照
 * Webhook：设了关键词后，每条消息都必须带上它（钉钉安全设置要求）
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { Monitor } = require('../src/core/engine/monitor');
const { Config } = require('../src/core/config');
const { Notifier } = require('../src/core/notify');
const { Logger } = require('../src/core/logger');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

const target = {
  id: 't_email',
  kind: 'market',
  slug: 'ash_prime_set',
  nameZh: 'Ash Prime 一套',
  nameEn: 'Ash Prime Set',
  direction: 'buy',
  targetPrice: 200,
  buyerFilter: 'all',
  intervalSec: 60,
  confirmRounds: 1,
};

const snapshot = {
  kind: 'market',
  direction: 'buy',
  bestPrice: 59,
  targetPrice: 200,
  matched: true,
  delta: 141,
  countAtTarget: 3,
  totalEligible: 489,
  ts: Date.now(),
  bestOrder: {
    id: 'o1',
    type: 'sell',
    platinum: 59,
    quantity: 2,
    perTrade: 1,
    rank: null,
    user: { name: 'Oshenbigking', status: 'ingame', reputation: 83, slug: 'x' },
  },
};

const deps = {
  config: { get: () => ({ notify: {}, global: {} }) },
  logger: new Logger({ level: 'error' }),
  store: { getRuntime: () => null, getHistory: () => [], pushHistory() {}, setRuntime() {}, appendEvent() {} },
  catalog: { attrs: () => [{ slug: 'critical_chance', zh: '暴击率', en: 'Critical Chance' }] },
  notifier: { dispatch: async () => ({ results: [] }) },
};

(async () => {
  // ---------- 邮件 ----------
  const mon = new Monitor({ target, deps });
  const msg = mon.buildMessage(snapshot);
  check('主题包含 warframe.market', /warframe\.market/.test(msg.emailSubject), msg.emailSubject);
  check('主题包含物品名', msg.emailSubject.includes('Ash Prime 一套'));
  check('主题包含价格', msg.emailSubject.includes('59p'));
  check('正文是 HTML', /^<!DOCTYPE html>/.test(msg.emailHtml));
  check('正文含物品名与价格', msg.emailHtml.includes('Ash Prime 一套') && msg.emailHtml.includes('59p'));
  check('正文含卖家', msg.emailHtml.includes('Oshenbigking'));
  check('正文含跳转链接', msg.emailHtml.includes('warframe.market/zh-hans/items/ash_prime_set'));
  check('纯文本兜底也在', msg.body.includes('达标挂单'));

  // ---------- 英文界面下的通知 ----------
  const enDeps = { ...deps, config: { get: () => ({ notify: {}, global: {}, ui: { language: 'en' } }) } };
  const monEN = new Monitor({ target, deps: enDeps });
  const msgEN = monEN.buildMessage(snapshot);
  check('EN 主题含英文物品名', msgEN.emailSubject.includes('Ash Prime Set'), msgEN.emailSubject);
  check('EN 主题用 [warframe.market hit]', /^\[warframe\.market hit\]/.test(msgEN.emailSubject));
  check('EN 正文无中文', !/[\u4e00-\u9fa5]/.test(`${msgEN.title}\n${msgEN.body}`), msgEN.title);
  check('EN 链接走英文站（无 /zh-hans/）', msgEN.body.includes('https://warframe.market/items/ash_prime_set'));
  check('ZH 链接走中文站', msg.body.includes('https://warframe.market/zh-hans/items/ash_prime_set'));

  // ---------- Webhook 关键词 ----------
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"errcode":0,"errmsg":"ok"}');
    });
  });
  await new Promise((r) => server.listen(17399, '127.0.0.1', r));

  const dataDir = path.join(__dirname, '..', '_tmp', 'udata-notify');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config = new Config(dataDir);
  config.patch({
    notify: {
      desktop: { enabled: false },
      smtp: { enabled: false },
      webhook: { enabled: true, kind: 'dingtalk', url: 'http://127.0.0.1:17399/hook', keyword: 'WFM' },
    },
  });
  const notifier = new Notifier({ config, logger: deps.logger, hooks: {} });
  const r = await notifier.dispatch({ title: msg.title, body: msg.body, event: { targetId: 't_email' } });
  check('Webhook 发送成功', r.results.some((x) => x.channel === 'webhook' && x.ok), JSON.stringify(r.results));
  check('请求体带关键词（title）', !!received && String(received.markdown?.title || '').includes('WFM'), received && received.markdown?.title);
  check('请求体带关键词（text）', !!received && String(received.markdown?.text || '').includes('WFM'));
  check('正文内容仍在', !!received && String(received.markdown?.text || '').includes('Ash Prime 一套'));

  // 关键词为空时不应凭空插入
  config.patch({ notify: { webhook: { keyword: '' } } });
  received = null;
  await notifier.dispatch({ title: msg.title, body: msg.body, event: {} });
  check('未设关键词时不插入', !!received && !String(received.markdown?.text || '').startsWith('\n'));

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
