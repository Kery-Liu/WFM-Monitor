'use strict';

/**
 * 存储层：目标 / 事件 / 价格历史
 * 用 JSON + NDJSON 而不是 SQLite：零原生依赖（Electron 打包不会因 ABI 不匹配炸掉），
 * 对「几十个目标 + 几千条事件」这个量级完全够用。
 */

const path = require('path');
const { readJsonSafe, writeJsonAtomic, appendLine, trimLines } = require('../util');

class Store {
  constructor({ dataDir, logger }) {
    this.dir = dataDir;
    this.logger = logger;
    this.targetsFile = path.join(dataDir, 'targets.json');
    this.eventsFile = path.join(dataDir, 'events.ndjson');
    this.historyFile = path.join(dataDir, 'history.json');
    this.runtimeFile = path.join(dataDir, 'runtime.json');

    this.targets = readJsonSafe(this.targetsFile, { version: 1, list: [] }) || { version: 1, list: [] };
    if (!Array.isArray(this.targets.list)) this.targets.list = [];
    this.history = readJsonSafe(this.historyFile, {}) || {};
    this.runtime = readJsonSafe(this.runtimeFile, {}) || {};
    this._historyDirty = false;
    this._runtimeDirty = false;
    this._saveTimer = null;
  }

  // ---------- targets ----------
  listTargets() {
    return this.targets.list;
  }

  getTarget(id) {
    return this.targets.list.find((t) => t.id === id) || null;
  }

  upsertTarget(target) {
    const idx = this.targets.list.findIndex((t) => t.id === target.id);
    if (idx >= 0) this.targets.list[idx] = target;
    else this.targets.list.push(target);
    this.flushTargets();
    return target;
  }

  removeTarget(id) {
    const before = this.targets.list.length;
    this.targets.list = this.targets.list.filter((t) => t.id !== id);
    delete this.history[id];
    delete this.runtime[id];
    this.flushHistory(true);
    this.flushRuntime(true);
    this.flushTargets();
    return before !== this.targets.list.length;
  }

  flushTargets() {
    writeJsonAtomic(this.targetsFile, this.targets);
  }

  // ---------- events ----------
  appendEvent(ev) {
    try {
      appendLine(this.eventsFile, ev);
      trimLines(this.eventsFile, 4000);
    } catch (e) {
      this.logger.warn('store', `写事件失败：${e.message}`);
    }
  }

  recentEvents(limit = 200) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(this.eventsFile)) return [];
      const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch (_) {
      return [];
    }
  }

  clearEvents() {
    try {
      require('fs').writeFileSync(this.eventsFile, '', 'utf8');
    } catch (_) {}
  }

  // ---------- runtime（冷却/去重状态，跨重启保留） ----------
  getRuntime(targetId) {
    return this.runtime[targetId] || null;
  }

  setRuntime(targetId, patch) {
    this.runtime[targetId] = { ...(this.runtime[targetId] || {}), ...patch };
    this._runtimeDirty = true;
    this._scheduleFlush();
  }

  removeRuntime(targetId) {
    delete this.runtime[targetId];
    this._runtimeDirty = true;
    this._scheduleFlush();
  }

  // ---------- price history ----------
  pushHistory(targetId, point, maxPoints = 240) {
    if (!this.history[targetId]) this.history[targetId] = [];
    const arr = this.history[targetId];
    arr.push(point);
    if (arr.length > maxPoints) arr.splice(0, arr.length - maxPoints);
    this._historyDirty = true;
    this._scheduleFlush();
  }

  getHistory(targetId) {
    return this.history[targetId] || [];
  }

  _scheduleFlush() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushHistory();
      this.flushRuntime();
    }, 5000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flushHistory(force = false) {
    if (!this._historyDirty && !force) return;
    try {
      writeJsonAtomic(this.historyFile, this.history);
      this._historyDirty = false;
    } catch (e) {
      this.logger.warn('store', `写历史失败：${e.message}`);
    }
  }

  flushRuntime(force = false) {
    if (!this._runtimeDirty && !force) return;
    try {
      writeJsonAtomic(this.runtimeFile, this.runtime);
      this._runtimeDirty = false;
    } catch (e) {
      this.logger.warn('store', `写运行态失败：${e.message}`);
    }
  }
}

module.exports = { Store };
