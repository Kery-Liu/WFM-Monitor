'use strict';

/** 极简日志层：内存环形缓冲 + 控制台输出，UI 可直接拉取 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor({ capacity = 500, level = 'info' } = {}) {
    this.capacity = capacity;
    this.level = level;
    this.buffer = [];
    this.listeners = new Set();
  }

  _push(level, scope, msg, extra) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const rec = {
      ts: Date.now(),
      level,
      scope,
      msg,
      extra: extra && typeof extra === 'object' ? safe(extra) : extra,
    };
    this.buffer.push(rec);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    if (level === 'error' || level === 'warn') {
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : 'warn'](`[${scope}] ${msg}`, extra || '');
    }
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch (_) {}
    }
  }

  debug(scope, msg, extra) { this._push('debug', scope, msg, extra); }
  info(scope, msg, extra) { this._push('info', scope, msg, extra); }
  warn(scope, msg, extra) { this._push('warn', scope, msg, extra); }
  error(scope, msg, extra) { this._push('error', scope, msg, extra); }

  tail(n = 200) {
    return this.buffer.slice(-n);
  }

  onRecord(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function safe(o) {
  try {
    return JSON.parse(JSON.stringify(o));
  } catch (_) {
    return String(o);
  }
}

module.exports = { Logger, LEVELS };
