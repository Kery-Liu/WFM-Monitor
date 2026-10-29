'use strict';

/**
 * HTTP 客户端层
 * 职责：拼 URL / 注入全局头 / 走限速 / 走熔断 / 超时 / 重试退避 / 错误分类 / 统计
 * 不做任何业务解析——业务解析在 sources 层。
 */

const https = require('https');
const zlib = require('zlib');
const { AppError, KINDS, fromNodeError, fromHttpStatus } = require('../errors');
const { RateLimiter } = require('./rateLimiter');
const { CircuitBreaker } = require('./breaker');
const { ProxyAgent } = require('./proxyAgent');
const { sleep, jitter } = require('../util');

const BASE = 'https://api.warframe.market';

class HttpClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    const g = config.get().global;
    const n = config.get().network;
    this.limiter = new RateLimiter({ minIntervalMs: g.minRequestIntervalMs, maxConcurrent: g.maxConcurrent });
    this.breaker = new CircuitBreaker({ threshold: n.breakerThreshold, cooldownMs: n.breakerCooldownSec * 1000, logger });
    this.agent = this._makeAgent();
    this.stats = {
      total: 0,
      ok: 0,
      fail: 0,
      byKind: {},
      latencies: [],
      lastSuccessAt: 0,
      lastErrorAt: 0,
      lastError: null,
      bytes: 0,
    };
  }

  _makeAgent() {
    const g = this.config.get().global;
    if (g.proxyUrl && /^https?:\/\//i.test(g.proxyUrl)) {
      try {
        return new ProxyAgent(g.proxyUrl);
      } catch (e) {
        this.logger.warn('http', `代理地址无效，已忽略：${e.message}`);
        return new https.Agent({ keepAlive: true, maxSockets: 4 });
      }
    }
    return new https.Agent({ keepAlive: true, maxSockets: 4 });
  }

  reload() {
    const g = this.config.get().global;
    const n = this.config.get().network;
    this.limiter.configure({ minIntervalMs: g.minRequestIntervalMs, maxConcurrent: g.maxConcurrent });
    this.breaker.configure({ threshold: n.breakerThreshold, cooldownMs: n.breakerCooldownSec * 1000 });
    const oldAgent = this.agent;
    this.agent = this._makeAgent();
    try {
      oldAgent.destroy();
    } catch (_) {}
  }

  /**
   * @param {string} pathWithQuery 形如 /v2/orders/item/ash_prime_set
   * @param {object} opts { method, priority, timeoutMs, retries, headers, expectJson }
   */
  async request(pathWithQuery, opts = {}) {
    const n = this.config.get().network;
    const retries = opts.retries !== undefined ? opts.retries : n.retries;
    let attempt = 0;
    let lastErr = null;

    while (attempt <= retries) {
      if (!opts.bypassBreaker && !this.breaker.canPass()) {
        const snap = this.breaker.snapshot();
        throw new AppError(KINDS.SERVER, `熔断中，${snap.reopenInSec}s 后自动重试`, {
          retryable: true,
          advice: '连续请求失败已触发熔断保护。请检查网络/代理，或点击「网络自检」定位原因。',
        });
      }
      let release = null;
      try {
        release = await this.limiter.acquire(opts.priority === undefined ? 10 : opts.priority);
        const res = await this._raw(pathWithQuery, opts);
        this.breaker.onSuccess();
        this._recordOk(res.latencyMs, res.bytes);
        return res;
      } catch (err) {
        lastErr = err instanceof AppError ? err : fromNodeError(err, { label: opts.label || '请求' });
        if (lastErr.kind === KINDS.RATE_LIMITED) this.limiter.coolDown(2000 + attempt * 1500);
        if (lastErr.kind === KINDS.TOO_MANY_CONN) this.limiter.coolDown(3000);
        // 只有「网络/服务端」类故障才计入熔断；404/参数错 这类不该拖垮整条链路
        if (lastErr.retryable) this.breaker.onFailure();
        this._recordFail(lastErr);
        const canRetry = lastErr.retryable && attempt < retries;
        if (!canRetry) throw lastErr;
        const wait = jitter(Math.min(n.backoffMaxMs, n.backoffBaseMs * 2 ** attempt), 25);
        this.logger.debug('http', `${pathWithQuery} 第 ${attempt + 1} 次失败(${lastErr.kind})，${wait}ms 后重试`);
        await sleep(wait);
        attempt += 1;
      } finally {
        if (release) release();
      }
    }
    throw lastErr || new AppError(KINDS.UNKNOWN, '请求失败');
  }

  _raw(pathWithQuery, opts) {
    const g = this.config.get().global;
    const n = this.config.get().network;
    const timeoutMs = opts.timeoutMs || n.timeoutMs;
    const url = new URL(pathWithQuery, BASE);
    const headers = {
      Accept: 'application/json',
      // 官方接口的订单响应明文 190–630 KB，gzip 后可压到 1/5，是刷新率的主要成本
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': g.userAgent || 'WFM-Monitor/1.0',
      Language: g.language || 'zh-hans',
      Platform: g.platform || 'pc',
      Crossplay: String(g.crossplay !== false),
      ...(opts.headers || {}),
    };
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: opts.method || 'GET',
          headers,
          agent: this.agent,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (c) => {
            bytes += c.length;
            if (bytes > 12 * 1024 * 1024) {
              req.destroy(new AppError(KINDS.BAD_RESPONSE, '响应体过大，已中断'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const latencyMs = Date.now() - started;
            // bytes 统计的是线上实际传输量（压缩后），带宽预算校准用它；
            // 解析用解压后的 buf，两者不能混
            const raw = Buffer.concat(chunks);
            let buf = raw;
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip' || enc === 'deflate') {
              try {
                buf = enc === 'gzip' ? zlib.gunzipSync(raw) : zlib.inflateSync(raw);
              } catch (e) {
                return reject(new AppError(KINDS.BAD_RESPONSE, '响应解压失败', { status: res.statusCode || 0, detail: e.message }));
              }
              // 压缩炸弹兜底：正常订单响应解压后不超过 1 MB
              if (buf.length > 32 * 1024 * 1024) {
                return reject(new AppError(KINDS.BAD_RESPONSE, '解压后响应体过大，已中断', { status: res.statusCode || 0 }));
              }
            }
            const text = buf.toString('utf8');
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              return reject(fromHttpStatus(status, text, { path: url.pathname }));
            }
            let json = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch (e) {
                return reject(new AppError(KINDS.BAD_RESPONSE, 'JSON 解析失败', { status, detail: text.slice(0, 300) }));
              }
            }
            return resolve({ status, headers: res.headers, json, text, latencyMs, bytes });
          });
          res.on('error', (e) => reject(fromNodeError(e, { label: '读取响应' })));
        }
      );

      req.on('timeout', () => {
        const e = new Error(`请求超时 ${timeoutMs}ms`);
        e.code = 'ETIMEDOUT';
        req.destroy(e);
      });
      req.on('error', (e) => reject(e instanceof AppError ? e : fromNodeError(e, { label: '请求' })));
      req.end();
    });
  }

  _recordOk(latencyMs, bytes) {
    this.stats.total += 1;
    this.stats.ok += 1;
    this.stats.bytes += bytes || 0;
    this.stats.lastSuccessAt = Date.now();
    this.stats.latencies.push(latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
  }

  _recordFail(err) {
    this.stats.total += 1;
    this.stats.fail += 1;
    this.stats.lastErrorAt = Date.now();
    this.stats.lastError = err.toJSON ? err.toJSON() : { message: String(err) };
    this.stats.byKind[err.kind] = (this.stats.byKind[err.kind] || 0) + 1;
  }

  snapshot() {
    const l = this.stats.latencies.slice().sort((a, b) => a - b);
    const pct = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor((p / 100) * l.length))] : null);
    return {
      total: this.stats.total,
      ok: this.stats.ok,
      fail: this.stats.fail,
      successRate: this.stats.total ? +(this.stats.ok / this.stats.total).toFixed(3) : null,
      byKind: this.stats.byKind,
      p50: pct(50),
      p95: pct(95),
      lastSuccessAt: this.stats.lastSuccessAt,
      lastErrorAt: this.stats.lastErrorAt,
      lastError: this.stats.lastError,
      queued: this.limiter.queued,
      inFlight: this.limiter.inFlight,
      coolingDown: this.limiter.coolingDown,
      breaker: this.breaker.snapshot(),
      proxy: this.config.get().global.proxyUrl || null,
    };
  }
}

module.exports = { HttpClient, BASE };
