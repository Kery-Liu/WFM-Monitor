'use strict';

/** 配置层：默认值 + 读取/保存/迁移 */

const path = require('path');
const { readJsonSafe, writeJsonAtomic, clamp } = require('./util');

const DEFAULTS = {
  version: 4, // 1=v1.0.0，2=快捷键，3=自动调度，4=配额分配制（tiers/degrade 废弃）
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
  // 自动调度 v1.2.1：配额分配制。容量先算出来，再按优先级权重（高4/中2/低1，
  // 见 engine/budget.js）分给每个目标，间隔是推导值而不是固定档位。
  // auto=false 时完全退回旧行为（每个目标用自己填的 intervalSec）。
  // bandwidth* 是内部参数：不给 UI 暴露，用户只拨优先级。
  schedule: {
    auto: true,
    budget: {
      bandwidthKbPerMin: 6000, // 真正的天花板口径：每分钟允许多少 KB
      avgKbPerCheck: 300, // 初值，运行期由 client.stats 用 EWMA 校准
      calibrate: true,
      minChecksPerMin: 6, // 下限：目标少时别被预算误限
      // 上次会话收敛的容量记忆（退出时由 scheduler.persistBudget 写入）：
      // 下次启动用 storedCapacity − 10 保守起步，省掉冷启动校准。
      // 0 = 无历史。恢复安全闸见 engine/budget.js 的 resumeCapacity。
      storedCapacity: 0,
      storedAvgKb: 0,
    },
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
    compact: false,
    confirmOnDelete: true,
    // 私聊文案语言不设开关：固定跟随对方（卖家/买家）在站内用的语言，见 app.js whisperLangFor()
    language: 'zh', // zh | en —— 整个界面与通知文案的语言
    theme: 'auto', // auto | dark | light —— auto 跟随系统，探测不到用 light
    // 全局快捷键：默认启用，开箱即可用 Ctrl/Cmd+Shift+F9 触发「全部检查」
    hotkey: { enabled: true, accelerator: 'CommandOrControl+Shift+F9' },
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
    const saved = readJsonSafe(this.file, null);
    // 用 defaults() 的深拷贝做底，避免运行时改动反向污染 DEFAULTS
    this.data = deepMerge(Config.defaults(), saved || {});
    this._migrate(!!saved);
    this._clamp();
  }

  /**
   * 老配置迁移
   * v1.0.0 的默认值是「快捷键关闭」，结果开箱时 Ctrl+Shift+F9 从没注册上；
   * v1.0.1 改为默认启用，这里把 v1 配置一次性打开（用户之后仍可手动关闭）。
   * v1.2.0 起私聊文案语言固定跟随对方，老配置里的 whisperLang 直接丢弃。
   */
  _migrate(persisted) {
    let dirty = false;

    if (this.data.ui && typeof this.data.ui === 'object' && 'whisperLang' in this.data.ui) {
      delete this.data.ui.whisperLang;
      dirty = true;
    }

    if ((Number(this.data.version) || 1) < 2) {
      if (!this.data.ui || typeof this.data.ui !== 'object') this.data.ui = Config.defaults().ui;
      const def = DEFAULTS.ui.hotkey;
      const hk = this.data.ui.hotkey && typeof this.data.ui.hotkey === 'object' ? { ...this.data.ui.hotkey } : { ...def };
      if (!hk.accelerator) hk.accelerator = def.accelerator;
      hk.enabled = true;
      this.data.ui.hotkey = hk;
      this.data.version = 2;
      dirty = true;
    }

    if ((Number(this.data.version) || 1) < 3) {
      // v1.2.0：补自动调度段。deepMerge 通常已经把默认值填进来了，
      // 这里兜住「settings.json 被手改过」的情况，并把版本号推上去。
      if (!this.data.schedule || typeof this.data.schedule !== 'object') {
        this.data.schedule = JSON.parse(JSON.stringify(DEFAULTS.schedule));
      }
      this.data.version = 3;
      dirty = true;
    }

    if ((Number(this.data.version) || 1) < 4) {
      // v1.2.1 配额分配制：tiers（固定秒数）与 degrade（降级参数）废弃。
      // 不删旧字段——留着无害，deepMerge 也不会把它们带回新默认里；
      // 只推版本号，新代码不再读这两个字段。
      this.data.version = 4;
      dirty = true;
    }

    if (dirty && persisted) {
      try {
        this.save();
      } catch (_) {}
    }
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
    const sc = this.data.schedule;
    // tiers 字段 v1.2.1 起废弃（间隔改为推导值），老配置里残留的不再钳制也不再读取
    if (sc && sc.budget) {
      sc.budget.bandwidthKbPerMin = clamp(Number(sc.budget.bandwidthKbPerMin) || 6000, 300, 60000);
      sc.budget.avgKbPerCheck = clamp(Number(sc.budget.avgKbPerCheck) || 300, 20, 800);
      sc.budget.minChecksPerMin = clamp(Number(sc.budget.minChecksPerMin) || 6, 1, 600);
      // 容量记忆：出界一律按无历史处理（resumeCapacity 会拒绝并回归冷启动）
      sc.budget.storedCapacity = Math.round(clamp(Number(sc.budget.storedCapacity) || 0, 0, 176));
      sc.budget.storedAvgKb = Math.round(clamp(Number(sc.budget.storedAvgKb) || 0, 0, 800));
    }
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

  /**
   * 容量记忆专用写入：绕过 patch/_afterSettingsChange（退出时不需要触发
   * 调度重排，只需要落盘）。容量/体积的合法性由调用方（scheduler.persistBudget）把关。
   */
  setBudgetMemory(capacity, avgKb) {
    if (!this.data.schedule || !this.data.schedule.budget) return false;
    this.data.schedule.budget.storedCapacity = Math.round(clamp(Number(capacity) || 0, 0, 176));
    this.data.schedule.budget.storedAvgKb = Math.round(clamp(Number(avgKb) || 0, 0, 800) * 10) / 10;
    try {
      this.save();
      return true;
    } catch (_) {
      return false;
    }
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
