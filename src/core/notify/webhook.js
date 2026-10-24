'use strict';

/**
 * 通知通道：Webhook（企业微信 / 钉钉 / 自定义）
 * 用原生 https 发送，避免引入额外 HTTP 库
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJson(urlStr, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('Webhook 地址格式不正确'));
    }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(text);
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Webhook 超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
    return undefined;
  });
}

class WebhookChannel {
  constructor({ config }) {
    this.config = config;
  }

  get cfg() {
    return this.config.get().notify.webhook;
  }

  get enabled() {
    const c = this.cfg;
    return c.enabled === true && !!c.url;
  }

  async send(payload) {
    if (!this.enabled) return { channel: 'webhook', skipped: true, reason: '未启用或未填地址' };
    const c = this.cfg;
    // 钉钉/企微的「自定义关键词」安全设置在服务端校验：消息里必须出现该词才放行
    const kw = (c.keyword || '').trim();
    const withKw = (text) => (kw ? `${kw}\n${text}` : text);
    const title = kw ? `${kw} ${payload.title}` : payload.title;

    let body;
    if (c.kind === 'wecom') {
      body = {
        msgtype: 'markdown',
        markdown: { content: withKw(`**${payload.title}**\n${payload.body.replace(/\n/g, '\n> ')}`) },
      };
    } else if (c.kind === 'dingtalk') {
      body = {
        msgtype: 'markdown',
        markdown: { title, text: withKw(`### ${payload.title}\n\n${payload.body.replace(/\n/g, '\n\n')}`) },
      };
    } else {
      body = { keyword: kw || null, title, content: withKw(payload.body), event: payload.event || null };
    }
    try {
      const resp = await postJson(c.url, body);
      // 钉钉/企微 200 也可能是业务错误，body 里会带 errcode
      let parsed = null;
      try {
        parsed = JSON.parse(String(resp));
      } catch (_) {}
      if (parsed && parsed.errcode && parsed.errcode !== 0) {
        return { channel: 'webhook', ok: false, error: `平台返回错误 ${parsed.errcode}: ${parsed.errmsg || ''}` };
      }
      return { channel: 'webhook', ok: true, detail: String(resp).slice(0, 200) };
    } catch (e) {
      return { channel: 'webhook', ok: false, error: e.message };
    }
  }
}

module.exports = { WebhookChannel, postJson };
