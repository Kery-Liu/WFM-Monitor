'use strict';

/** 通知通道：Windows 原生桌面通知（由 Electron 主进程注入实现） */

class DesktopChannel {
  constructor({ config, hooks }) {
    this.config = config;
    this.hooks = hooks || {};
  }

  get enabled() {
    return this.config.get().notify.desktop.enabled !== false;
  }

  async send(payload) {
    if (!this.enabled) return { channel: 'desktop', skipped: true, reason: '未启用' };
    if (typeof this.hooks.showDesktop !== 'function') return { channel: 'desktop', skipped: true, reason: '无桌面环境' };
    try {
      await this.hooks.showDesktop({
        title: payload.title,
        body: payload.body,
        urgency: payload.urgency || 'normal',
        targetId: payload.targetId,
        silent: !!payload.silent,
      });
      return { channel: 'desktop', ok: true };
    } catch (e) {
      return { channel: 'desktop', ok: false, error: e.message };
    }
  }
}

module.exports = { DesktopChannel };
