'use strict';

/**
 * 通知派发层
 * 职责：拼装消息文案 / 安静时段判断 / 全局限流 / 并发投递到已启用通道 / 汇总结果
 * 去重与冷却在 Monitor 层做（那里才知道「同一个目标」的上下文）
 */

const { DesktopChannel } = require('./desktop');
const { WebhookChannel } = require('./webhook');
const { SmtpChannel } = require('./smtp');

class Notifier {
  constructor({ config, logger, hooks }) {
    this.config = config;
    this.logger = logger;
    this.channels = {
      desktop: new DesktopChannel({ config, hooks }),
      webhook: new WebhookChannel({ config }),
      smtp: new SmtpChannel({ config, logger }),
    };
    this.sentTimestamps = [];
  }

  activeChannels() {
    return Object.entries(this.channels)
      .filter(([, ch]) => ch.enabled)
      .map(([name]) => name);
  }

  inQuietHours(date = new Date()) {
    const q = this.config.get().notify.quietHours;
    if (!q.enabled) return false;
    const [sh, sm] = String(q.start).split(':').map(Number);
    const [eh, em] = String(q.end).split(':').map(Number);
    const cur = date.getHours() * 60 + date.getMinutes();
    const start = sh * 60 + (sm || 0);
    const end = eh * 60 + (em || 0);
    if (start === end) return false;
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  hourlyCount() {
    const cutoff = Date.now() - 3600 * 1000;
    this.sentTimestamps = this.sentTimestamps.filter((t) => t > cutoff);
    return this.sentTimestamps.length;
  }

  async dispatch({ title, body, event, urgency = 'normal', silent = false, emailSubject = '', emailHtml = '' }) {
    const cfg = this.config.get().notify;
    if (this.hourlyCount() >= cfg.maxPerHour) {
      this.logger.warn('notify', `已达每小时通知上限 ${cfg.maxPerHour}，本次仅记录`);
      return { suppressed: true, reason: 'hourly_cap', results: [] };
    }
    const quiet = this.inQuietHours();
    const results = [];

    for (const [name, ch] of Object.entries(this.channels)) {
      if (!ch.enabled) continue;
      if (quiet && name === 'desktop') {
        results.push({ channel: name, skipped: true, reason: '安静时段' });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await ch.send({
          title,
          body,
          event,
          urgency,
          silent: silent || quiet,
          targetId: event?.targetId,
          emailSubject,
          emailHtml,
        });
        results.push(r);
      } catch (e) {
        results.push({ channel: name, ok: false, error: e.message });
      }
    }
    this.sentTimestamps.push(Date.now());
    this.logger.info('notify', `通知已派发：${title}`, { results });
    return { suppressed: false, quiet, results };
  }

  /** 设置页「测试通知」按钮 */
  async test() {
    const now = new Date().toLocaleTimeString('zh-CN');
    return this.dispatch({
      title: '【WFM 监控】测试通知',
      body: `这是一条测试消息，发送时间 ${now}。\n如果你看到了它，说明通知通道工作正常。`,
      event: { kind: 'test' },
    });
  }
}

module.exports = { Notifier };
