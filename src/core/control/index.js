'use strict';

/**
 * 邮件反控制（路线 A：IMAP 轮询）
 *
 * 流程：定时连 IMAP -> 取未读 -> 白名单+口令校验 -> 解析指令 -> 执行 -> 回信 -> 标记已处理
 *
 * 设计要点：
 *   - 只读 + 检查两类指令，写操作（暂停/恢复）暂不开放
 *   - 未达标也必须回信（用户明确要求），内容为全部目标的价格汇总
 *   - 幂等：同一 UID 只处理一次，重启后不重复执行
 *   - 限流：窗口内最多 N 条，防止被刷
 *   - 鉴权：发件人白名单（留空则只允许本账号自己发给自己）+ 可选口令
 */

const fs = require('fs');
const path = require('path');
const { parseCommand, helpText } = require('./commands');
const { buildReply } = require('./composer');

let ImapFlow = null;
let simpleParser = null;
try {
  ({ ImapFlow } = require('imapflow'));
  ({ simpleParser } = require('mailparser'));
} catch (_) {
  /* 依赖缺失时降级：控制功能不可用，但主程序照常跑 */
}

class EmailControl {
  constructor({ config, logger, app }) {
    this.config = config;
    this.logger = logger;
    this.app = app;
    this.timer = null;
    this.polling = false;
    this.lastPollAt = 0;
    this.lastError = null;
    this.lastCommand = null;
    this.lastReplyAt = 0;
    this.history = [];
    this._rate = [];
    this._store = null;
    this._uids = new Set();
  }

  get cfg() {
    return this.config.get().control.email;
  }

  get enabled() {
    const c = this.cfg;
    return !!(c && c.enabled && c.host && c.user && c.pass);
  }

  get available() {
    return !!(ImapFlow && simpleParser);
  }

  // ---------- 持久化已处理 UID ----------
  _loadStore() {
    if (this._store) return;
    const dir = this.app.dataDir;
    this._store = path.join(dir, 'control.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this._store, 'utf8'));
      if (Array.isArray(raw.uids)) this._uids = new Set(raw.uids);
    } catch (_) {
      this._uids = new Set();
    }
  }

  _saveStore() {
    try {
      const arr = Array.from(this._uids).slice(-800);
      fs.writeFileSync(this._store, JSON.stringify({ uids: arr }, null, 0), 'utf8');
    } catch (e) {
      this.logger.warn('control', `保存已处理 UID 失败：${e.message}`);
    }
  }

  // ---------- 生命周期 ----------
  start() {
    this.stop();
    if (!this.enabled || !this.available) {
      if (this.cfg?.enabled && !this.available) this.logger.warn('control', 'IMAP 依赖缺失，远程控制未启动');
      return;
    }
    this._loadStore();
    const interval = Math.max(20, Number(this.cfg.pollSec) || 60) * 1000;
    this.timer = setInterval(() => this.pollOnce().catch(() => {}), interval);
    if (this.timer.unref) this.timer.unref();
    // 启动后 8 秒先跑一次，别让用户干等
    setTimeout(() => this.pollOnce().catch(() => {}), 8000);
    this.logger.info('control', `邮件控制已启动，每 ${interval / 1000}s 轮询一次`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- 单次轮询 ----------
  async pollOnce() {
    if (!this.enabled || this.polling) return { skipped: true };
    this.polling = true;
    const c = this.cfg;
    const client = new ImapFlow({
      host: c.host,
      port: Number(c.port) || 993,
      secure: c.secure !== false,
      auth: { user: c.user, pass: c.pass },
      logger: false,
      emitLogs: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(c.mailbox || 'INBOX');
      const messages = [];
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        if (uids && uids.length) {
          for await (const msg of client.fetch(uids.slice(-30), { uid: true, source: true })) {
            let parsed;
            try {
              parsed = await simpleParser(msg.source);
            } catch (_) {
              continue;
            }
            messages.push({
              uid: String(msg.uid),
              from: parsed.from?.value?.[0]?.address || '',
              fromName: parsed.from?.value?.[0]?.name || '',
              subject: parsed.subject || '',
              text: parsed.text || '',
              date: parsed.date ? parsed.date.getTime() : Date.now(),
              // 处理完顺手标已读，避免下次重复拉
              markSeen: async () => {
                try {
                  await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
                } catch (_) {}
              },
            });
          }
        }
      } finally {
        lock.release();
      }

      const result = await this.handleIncoming(messages);
      this.lastPollAt = Date.now();
      this.lastError = null;
      return result;
    } catch (e) {
      this.lastError = e.message;
      this.logger.warn('control', `IMAP 轮询失败：${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      this.polling = false;
      try {
        await client.logout();
      } catch (_) {}
    }
  }

  // ---------- 鉴权 ----------
  _allowedSenders() {
    return String(this.cfg.allowFrom || '')
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  isAllowed(from) {
    const addr = String(from || '').toLowerCase();
    if (!addr) return false;
    const list = this._allowedSenders();
    if (list.length) return list.some((x) => addr.includes(x));
    // 没配白名单时，只允许本账号自己发给自己
    const self = String(this.cfg.user || '').toLowerCase();
    return !!self && addr.includes(self);
  }

  _matchesPassphrase(subject, text) {
    const pass = String(this.cfg.passphrase || '').trim();
    if (!pass) return true;
    return String(subject || '').includes(pass) || String(text || '').includes(pass);
  }

  _stripPassphrase(text) {
    const pass = String(this.cfg.passphrase || '').trim();
    if (!pass) return text;
    return String(text || '').split(pass).join(' ');
  }

  _rateLimited() {
    const now = Date.now();
    this._rate = this._rate.filter((t) => now - t < 10 * 60 * 1000);
    const max = Math.max(1, Number(this.cfg.maxPer10Min) || 10);
    if (this._rate.length >= max) return true;
    this._rate.push(now);
    return false;
  }

  // ---------- 处理一批消息 ----------
  async handleIncoming(messages = []) {
    const out = { seen: messages.length, accepted: 0, ignored: 0, executed: 0, replied: 0 };
    for (const msg of messages) {
      // eslint-disable-next-line no-await-in-loop
      const r = await this.handleOne(msg);
      if (r.accepted) out.accepted += 1;
      else out.ignored += 1;
      if (r.executed) out.executed += 1;
      if (r.replied) out.replied += 1;
    }
    if (out.accepted) this._saveStore();
    return out;
  }

  async handleOne(msg) {
    const uid = String(msg.uid || '');
    this._loadStore();
    if (!uid || this._uids.has(uid)) return { accepted: false, reason: 'duplicate' };

    if (!this.isAllowed(msg.from)) {
      this.logger.warn('control', `拒绝非白名单来信：${msg.from || '(空)'}`);
      this._uids.add(uid);
      return { accepted: false, reason: 'sender_not_allowed' };
    }
    if (!this._matchesPassphrase(msg.subject, msg.text)) {
      this.logger.warn('control', `口令不匹配，忽略来自 ${msg.from} 的邮件`);
      this._uids.add(uid);
      return { accepted: false, reason: 'passphrase' };
    }

    const cmd = parseCommand(this._stripPassphrase(msg.text)) || parseCommand(msg.subject);
    if (!cmd) return { accepted: false, reason: 'no_command' };

    if (this._rateLimited()) {
      this._uids.add(uid);
      this.logger.warn('control', '指令频率超限，已忽略');
      return { accepted: true, executed: false, reason: 'rate_limited' };
    }

    this._uids.add(uid);
    this.lastCommand = { at: Date.now(), id: cmd.id, from: msg.from, subject: msg.subject };
    this.history.unshift({ at: Date.now(), id: cmd.id, from: msg.from, subject: msg.subject });
    this.history = this.history.slice(0, 20);
    this.logger.info('control', `收到指令 ${cmd.id}（来自 ${msg.from}）`);

    const lang = this.config.get().ui?.language === 'en' ? 'en' : 'zh';
    let note = '';
    if (cmd.id === 'check') {
      const r = await this.app.checkAllAndWait();
      note =
        lang === 'en'
          ? `${r.count} monitor(s) checked in ${(r.elapsed / 1000).toFixed(1)}s`
          : `${r.count} 个目标已完成检查，用时 ${(r.elapsed / 1000).toFixed(1)}s`;
    }

    const reply = buildReply({
      mode: cmd.id,
      lang,
      rows: cmd.id === 'help' ? [] : this.app.summaryRows(lang),
      note,
    });

    let replied = false;
    try {
      replied = await this.sendReply({ to: msg.from, subject: reply.subject, text: reply.text, html: reply.html });
      if (replied) this.lastReplyAt = Date.now();
    } catch (e) {
      this.lastError = e.message;
      this.logger.warn('control', `回信失败：${e.message}`);
    }

    if (msg.markSeen) await msg.markSeen();
    return { accepted: true, executed: true, replied, command: cmd.id, summary: reply.summary };
  }

  // ---------- 回信 ----------
  get smtpReady() {
    const s = this.config.get().notify.smtp;
    return !!(s && s.user && (s.pass || s.host));
  }

  async sendReply({ to, subject, text, html }) {
    if (!to) return false;
    if (!this.smtpReady) {
      this.logger.warn('control', '未配置 SMTP，无法回信（设置 → 通知 → 邮件）');
      return false;
    }
    if (!nodemailerLazy()) throw new Error('nodemailer 未安装');
    const s = this.config.get().notify.smtp;
    const transport = require('nodemailer').createTransport({
      host: s.host,
      port: Number(s.port) || 465,
      secure: s.secure !== false,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    await transport.sendMail({ from: s.user, to, subject, text, html });
    return true;
  }

  // ---------- 状态（给 UI） ----------
  status() {
    const c = this.cfg || {};
    return {
      enabled: this.enabled,
      available: this.available,
      polling: this.polling,
      lastPollAt: this.lastPollAt,
      lastReplyAt: this.lastReplyAt,
      lastError: this.lastError,
      lastCommand: this.lastCommand,
      history: this.history,
      smtpReady: this.smtpReady,
      allowedSenders: this._allowedSenders().length || (c.user ? 1 : 0),
      processed: this._uids.size,
      help: helpText(this.config.get().ui?.language === 'en' ? 'en' : 'zh'),
    };
  }
}

let _nodemailer = null;
function nodemailerLazy() {
  if (_nodemailer) return true;
  try {
    _nodemailer = require('nodemailer');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { EmailControl };
