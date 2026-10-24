'use strict';

/**
 * 邮件远程控制：指令解析 + 回复编排 + 处理流程
 * 不连真实 IMAP，直接喂消息给 handleIncoming，验证鉴权/幂等/限流/回复内容。
 */

const path = require('path');
const fs = require('fs');
const { parseCommand } = require('../src/core/control/commands');
const { buildReply, summarize, gapOf } = require('../src/core/control/composer');
const { EmailControl } = require('../src/core/control');
const { Config } = require('../src/core/config');
const { Logger } = require('../src/core/logger');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

const rows = [
  { label: 'Ash Prime 一套', enabled: true, state: 'trigger', kind: 'market', direction: 'buy', bestPrice: 59, targetPrice: 200, matched: true },
  { label: 'Nova Prime 一套', enabled: true, state: 'ok', kind: 'market', direction: 'buy', bestPrice: 120, targetPrice: 100, matched: false },
  { label: '赤毒怒雷紫卡', enabled: false, state: 'disabled', kind: 'auction', direction: 'buy', bestPrice: 480, targetPrice: 500, matched: false },
  { label: 'Mesa Prime 一套', enabled: true, state: 'error', kind: 'market', direction: 'buy', bestPrice: null, targetPrice: 80, matched: false },
];

// ---------- 1. 指令解析 ----------
check('解析「检查」', parseCommand('检查')?.id === 'check');
check('解析「全部检查」', parseCommand('全部检查')?.id === 'check');
check('解析带标点', parseCommand('检查。')?.id === 'check');
check('解析 en', parseCommand('Check')?.id === 'check');
check('解析 status', parseCommand('状态')?.id === 'status');
check('解析 help', parseCommand('帮助')?.id === 'help');
check('多行取第一条命中', parseCommand('你好\n检查一下\n谢谢')?.id === 'check');
check('无关正文不误判', parseCommand('今天天气不错') === null);
check('空正文不误判', parseCommand('') === null);

// ---------- 2. 汇总与差价 ----------
const s = summarize(rows, 'zh');
check('统计：1 达标 / 1 停用 / 1 异常', s.hit === 1 && s.disabled === 1 && s.errored === 1, JSON.stringify(s));
check('差价符号正确', gapOf(rows[0]) === 141 && gapOf(rows[1]) === -20, `${gapOf(rows[0])}/${gapOf(rows[1])}`);
check('无价时差价为空', gapOf(rows[3]) === null);

// ---------- 3. 回复内容 ----------
const reply = buildReply({ mode: 'check', lang: 'zh', rows, note: '4 个目标已完成检查' });
check('主题标明达标比', /1\/4 达标/.test(reply.subject), reply.subject);
check('无达标也要有全部目标', rows.every((r) => reply.text.includes(r.label)));
check('正文含差价', reply.text.includes('+141p') && reply.text.includes('-20p'));
check('正文标注停用/异常', reply.text.includes('[停用]') && reply.text.includes('[异常]'));
check('HTML 表格存在', reply.html.includes('<table') && reply.html.includes('Ash Prime 一套'));
check('英文版可生成', /hit/.test(buildReply({ mode: 'check', lang: 'en', rows }).subject));

// ---------- 4. handleIncoming：鉴权 / 幂等 / 执行 / 回信 ----------
(async () => {
  const dataDir = path.join(__dirname, '..', '_tmp', 'udata-control');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config = new Config(dataDir);
  config.patch({
    global: { language: 'zh-hans' },
    ui: { language: 'zh' },
    control: {
      email: {
        enabled: true, host: 'imap.example.com', port: 993, secure: true,
        user: 'me@example.com', pass: 'x', mailbox: 'INBOX', pollSec: 60,
        allowFrom: '', passphrase: 'wfm-9f3a', maxPer10Min: 3,
      },
    },
    notify: { smtp: { enabled: true, host: 'smtp.example.com', port: 465, secure: true, user: 'me@example.com', pass: 'x' } },
  });

  let checked = 0;
  const fakeApp = {
    dataDir,
    checkAllAndWait: async () => { checked += 1; return { count: 2, elapsed: 1234 }; },
    summaryRows: () => rows,
  };
  const ctl = new EmailControl({ config, logger: new Logger({ level: 'error' }), app: fakeApp });
  const sent = [];
  ctl.sendReply = async (m) => { sent.push(m); return true; };

  const mk = (uid, from, text, subject = '') => ({ uid: String(uid), from, subject, text, markSeen: async () => {} });

  // 非白名单（默认只允许自己）
  let r = await ctl.handleIncoming([mk(1, 'stranger@evil.com', '检查')]);
  check('拒绝陌生发件人', r.accepted === 0 && sent.length === 0);

  // 口令不匹配
  r = await ctl.handleIncoming([mk(2, 'me@example.com', '检查')]);
  check('口令不符不执行', r.accepted === 0 && sent.length === 0);

  // 正常指令
  r = await ctl.handleIncoming([mk(3, 'me@example.com', 'wfm-9f3a\n检查')]);
  check('白名单+口令通过并执行', r.executed === 1 && checked === 1);
  check('回了信', sent.length === 1);
  check('回信对象是发件人', sent[0]?.to === 'me@example.com');
  check('回信包含未达标目标', /Nova Prime 一套/.test(sent[0].text) && /停用/.test(sent[0].text));
  check('回信说明检查数量', /2 个目标已完成检查/.test(sent[0].text), sent[0].text.split('\n')[2]);

  // 幂等：同一 UID 再来一次
  const before = sent.length;
  r = await ctl.handleIncoming([mk(3, 'me@example.com', 'wfm-9f3a\n检查')]);
  check('同一 UID 不重复执行', r.accepted === 0 && sent.length === before && checked === 1);

  // 无指令的邮件：不执行也不回信
  r = await ctl.handleIncoming([mk(4, 'me@example.com', 'wfm-9f3a\n随便聊两句')]);
  check('无指令不执行', r.accepted === 0 && sent.length === before);

  // 限流：默认 3 条/10 分钟，已经用了 1 条
  await ctl.handleIncoming([mk(5, 'me@example.com', 'wfm-9f3a\n状态')]);
  await ctl.handleIncoming([mk(6, 'me@example.com', 'wfm-9f3a\n帮助')]);
  const beforeRate = checked;
  r = await ctl.handleIncoming([mk(7, 'me@example.com', 'wfm-9f3a\n检查')]);
  check('超过频率上限被拦截', r.accepted === 1 && !r.executed && checked === beforeRate, JSON.stringify(r));

  // 状态接口
  const st = ctl.status();
  check('status 提供 UI 需要的字段', st.enabled === true && st.smtpReady === true && st.processed >= 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})();
