'use strict';

/**
 * 限速层：全局限速闸 + 冷却惩罚 + 并发闸
 * 设计要点：
 *  - 所有请求「发起时刻」被严格串行到一个最小间隔，天然不会冲破官方 3 req/s
 *  - 遇到 429/509 时设置全局冷却，所有队列一起等待（而不是各自重试加重封锁）
 *  - 并发闸限制同时在飞的请求数，避免 509 too many connections
 */

class RateLimiter {
  constructor({ minIntervalMs = 500, maxConcurrent = 2 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxConcurrent = maxConcurrent;
    this.lastStart = 0;
    this.inFlight = 0;
    this.cooldownUntil = 0;
    this.queue = [];
    this._pumping = false;
    this._waiters = [];
    this.stats = { granted: 0, cooledDown: 0, totalWaitMs: 0 };
  }

  configure({ minIntervalMs, maxConcurrent }) {
    if (minIntervalMs) this.minIntervalMs = Math.max(340, minIntervalMs);
    if (maxConcurrent) this.maxConcurrent = Math.max(1, maxConcurrent);
    this._pump();
  }

  /** 全局冷却（429/509 后调用） */
  coolDown(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.stats.cooledDown += 1;
    this._pump();
  }

  get coolingDown() {
    return this.cooldownUntil > Date.now();
  }

  get queued() {
    return this.queue.length;
  }

  /**
   * 获取一个执行槽位。priority 数字越小越优先。
   * 返回 release() 由调用方在请求结束时执行。
   */
  acquire(priority = 10) {
    return new Promise((resolve) => {
      this.queue.push({ priority, resolve, enqueuedAt: Date.now() });
      this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
      this._pump();
    });
  }

  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.queue.length && this.inFlight < this.maxConcurrent) {
        const t = Date.now();
        const readyAt = Math.max(this.lastStart + this.minIntervalMs, this.cooldownUntil);
        if (t < readyAt) {
          const delay = readyAt - t;
          setTimeout(() => {
            this._pumping = false;
            this._pump();
          }, delay + 5);
          return;
        }
        const job = this.queue.shift();
        this.lastStart = Date.now();
        this.inFlight += 1;
        this.stats.granted += 1;
        this.stats.totalWaitMs += this.lastStart - job.enqueuedAt;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.inFlight = Math.max(0, this.inFlight - 1);
          this._pumping = false;
          this._pump();
        };
        job.resolve(release);
      }
    } finally {
      this._pumping = false;
    }
  }
}

module.exports = { RateLimiter };
