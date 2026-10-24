'use strict';

/** 配置层：默认值 + 读取/保存/迁移 */

const path = require('path');
const { readJsonSafe, writeJsonAtomic, clamp } = require('./util');

const DEFAULTS = {
  version: 1,
  global: {
    platform: 'pc', // pc | ps4 | xbox | switch | mobile
    crossplay: true,
    language: 'zh-hans',
    minRequestIntervalMs: 500, // 全局请求最小间隔，500ms ≈ 2 req/s（官方上限 3）
    maxConcurrent: 2,
    defaultIntervalSec: 60,
    minIntervalSec: 15,
    jitterPct: 15,
    paused: false,
    proxyUrl: '',
    userAgent: 'WFM-Monitor/1.0 (personal price watcher; contact: local)',
    historyPoints: 240,
  },
  network: {
    timeoutMs: 20000,
    retries: 2,
    backoffBaseMs: 1500,
    backoffMaxMs: 60000,
    breakerThreshold: 5,
    breakerCooldownSec: 60,
    streamEnabled: true,
    streamReconnectMaxSec: 60,
    statsCacheSec: 300,
  },
  notify: {
    desktop: { enabled: true },
    webhook: { enabled: false, kind: 'wecom', url: '', keyword: '', template: '' },
    smtp: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' },
    sound: { enabled: true },
    cooldownSec: 600,
    improveDelta: 5,
    requireConfirmRounds: 1,
    quietHours: { enabled: false, start: '23:30', end: '08:00' },
    maxPerHour: 30,
  },
  ui: {
    theme: 'dark',
    compact: false,
    confirmOnDelete: true,
    whisperLang: 'auto', // auto | en | zh —— 复制喊话时使用的语言
    language: 'zh', // zh | en —— 整个界面与通知文案的语言
    theme: 'auto', // auto | dark | light —— auto 跟随系统，探测不到用 light
    hotkey: { enabled: false, accelerator: 'CommandOrControl+Shift+F9' }, // 全局快捷键：触发全部检查
  },
  // 远程控制：目前只支持邮件（IMAP 轮询）
  control: {
    email: {
      enabled: false,
      host: '',
      port: 993,
      secure: true,
      user: '',
      pass: '',
      mailbox: 'INBOX',
      pollSec: 60,
      allowFrom: '', // 白名单，逗号分隔；留空 = 只允许本账号自己发给自己
      passphrase: '', // 可选口令，邮件正文或主题里必须包含
      maxPer10Min: 10,
    },
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

class Config {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.data = deepMerge(DEFAULTS, readJsonSafe(this.file, {}) || {});
    this._clamp();
  }

  _clamp() {
    const g = this.data.global;
    g.minRequestIntervalMs = clamp(Number(g.minRequestIntervalMs) || 500, 340, 10000);
    g.maxConcurrent = clamp(Number(g.maxConcurrent) || 2, 1, 6);
    g.defaultIntervalSec = clamp(Number(g.defaultIntervalSec) || 60, 15, 3600);
    g.minIntervalSec = clamp(Number(g.minIntervalSec) || 15, 10, 3600);
    const n = this.data.network;
    n.timeoutMs = clamp(Number(n.timeoutMs) || 20000, 5000, 120000);
    n.retries = clamp(Number(n.retries) || 2, 0, 5);
    const no = this.data.notify;
    no.cooldownSec = clamp(Number(no.cooldownSec) || 600, 0, 86400);
    no.improveDelta = clamp(Number(no.improveDelta) || 0, 0, 100000);
    no.requireConfirmRounds = clamp(Number(no.requireConfirmRounds) || 1, 1, 10);
    no.maxPerHour = clamp(Number(no.maxPerHour) || 30, 1, 500);
  }

  get() {
    return this.data;
  }

  patch(patchObj) {
    this.data = deepMerge(this.data, patchObj || {});
    this._clamp();
    this.save();
    return this.data;
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  /** 恢复出厂设置（会覆盖所有通知密钥类配置） */
  reset() {
    this.data = Config.defaults();
    this._clamp();
    this.save();
    return this.data;
  }

  static defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

module.exports = { Config, DEFAULTS };
