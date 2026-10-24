'use strict';

/**
 * 熔断器层
 * closed   : 正常放行
 * open     : 连续失败达阈值，直接快速失败（不浪费流量、不加重封锁）
 * half-open: 冷却结束后放一个探测请求，成功则恢复
 */

class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 60000, logger = null } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.logger = logger;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenTrial = false;
    this.tripCount = 0;
  }

  configure({ threshold, cooldownMs }) {
    if (threshold) this.threshold = threshold;
    if (cooldownMs) this.cooldownMs = cooldownMs;
  }

  canPass() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        this.halfOpenTrial = false;
        if (this.logger) this.logger.info('breaker', '熔断器进入半开状态，放行探测请求');
        return true;
      }
      return false;
    }
    // half-open：同时只放一个
    if (this.halfOpenTrial) return false;
    this.halfOpenTrial = true;
    return true;
  }

  onSuccess() {
    if (this.state !== 'closed') {
      if (this.logger) this.logger.info('breaker', '熔断器恢复：请求成功');
    }
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenTrial = false;
  }

  onFailure() {
    this.failures += 1;
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.tripCount += 1;
      if (this.logger) this.logger.warn('breaker', '探测失败，熔断器重新打开');
      return;
    }
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.tripCount += 1;
      if (this.logger) this.logger.warn('breaker', `连续失败 ${this.failures} 次，熔断 ${Math.round(this.cooldownMs / 1000)}s`);
    }
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      tripCount: this.tripCount,
      reopenInSec: this.state === 'open' ? Math.max(0, Math.ceil((this.openedAt + this.cooldownMs - Date.now()) / 1000)) : 0,
    };
  }

  /** 人工重置（自检时用，保证能探到真实原因而不是「熔断中」） */
  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenTrial = false;
    this.openedAt = 0;
  }
}

module.exports = { CircuitBreaker };
