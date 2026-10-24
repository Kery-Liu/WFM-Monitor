'use strict';

/**
 * 通知通道：邮件（SMTP / nodemailer，纯 JS 无原生依赖）
 * 约定：
 *   - 发件人固定 = SMTP 账号，不再单独配置
 *   - 收件人留空 = 发给自己（账号邮箱）
 *   - 邮件有固定版式：主题点明 warframe.market 达标 + 哪个物品，正文给完整快照
 */

let nodemailer = null;
try {
  // 延迟加载，未启用时不占启动时间
  nodemailer = require('nodemailer');
} catch (_) {}

class SmtpChannel {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.transport = null;
    this._signature = '';
  }

  get cfg() {
    return this.config.get().notify.smtp;
  }

  get enabled() {
    const c = this.cfg;
    return c.enabled === true && !!c.host && !!c.user;
  }

  /** 收件人：留空则发给自己 */
  recipients() {
    const c = this.cfg;
    const list = String(c.to || '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length && c.user) return [c.user];
    return list;
  }

  /** 发件人固定为账号本身 */
  sender() {
    return this.cfg.user;
  }

  _ensureTransport() {
    const c = this.cfg;
    const sig = [c.host, c.port, c.secure, c.user, c.pass].join('|');
    if (this.transport && sig === this._signature) return this.transport;
    if (!nodemailer) throw new Error('nodemailer 未安装');
    this.transport = nodemailer.createTransport({
      host: c.host,
      port: Number(c.port) || 465,
      secure: c.secure !== false,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    this._signature = sig;
    return this.transport;
  }

  async send(payload) {
    if (!this.enabled) return { channel: 'smtp', skipped: true, reason: '未启用或缺少服务器/账号' };
    try {
      const transport = this._ensureTransport();
      const to = this.recipients();
      if (!to.length) return { channel: 'smtp', skipped: true, reason: '没有收件人，也没有可用的账号邮箱' };

      const subject = payload.emailSubject || payload.title;
      const html = payload.emailHtml || plainToHtml(payload.body);
      const text = payload.body || '';

      await transport.sendMail({ from: this.sender(), to, subject, text, html });
      return { channel: 'smtp', ok: true, detail: `→ ${to.join(', ')}` };
    } catch (e) {
      return { channel: 'smtp', ok: false, error: e.message };
    }
  }

  async verify() {
    const transport = this._ensureTransport();
    await transport.verify();
    return true;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plainToHtml(text) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#1f2733">
    <pre style="white-space:pre-wrap;margin:0;font-family:inherit">${escapeHtml(text)}</pre>
  </div>`;
}

module.exports = { SmtpChannel, escapeHtml };
