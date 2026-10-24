'use strict';

/**
 * 数据源层 - WebSocket 实时流
 * 作用：新订单秒级推送，弥补轮询间隔内的空窗（轮询仍是主通道与兜底）
 * 已验证：匿名可用，但必须带 wfm 子协议 + Origin: https://warframe.market
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const { jitter } = require('../util');

const WS_URL = 'wss://ws.warframe.market/socket';

class OrderStream extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.state = 'idle'; // idle | connecting | open | closed | error
    this.reconnectAttempt = 0;
    this.timer = null;
    this.heartbeat = null;
    this.stats = {
      events: 0,
      connects: 0,
      reconnects: 0,
      lastEventAt: 0,
      lastError: null,
      subscribed: false,
      since: 0,
    };
    this._msgId = 0;
    this._stopped = false;
  }

  get enabled() {
    return this.config.get().network.streamEnabled !== false;
  }

  start() {
    this._stopped = false;
    if (!this.enabled) {
      this.state = 'idle';
      return;
    }
    if (this.state === 'open' || this.state === 'connecting') return;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this.timer);
    this._clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    this.state = 'closed';
    this.stats.subscribed = false;
  }

  restart() {
    this.stop();
    this._stopped = false;
    this.reconnectAttempt = 0;
    this.start();
  }

  _connect() {
    if (this._stopped) return;
    const g = this.config.get().global;
    this.state = 'connecting';
    this.emit('state', this.snapshot());

    let ws;
    try {
      ws = new WebSocket(WS_URL, 'wfm', {
        origin: 'https://warframe.market',
        headers: { 'User-Agent': g.userAgent || 'WFM-Monitor/1.0' },
        handshakeTimeout: 20000,
        perMessageDeflate: false,
      });
    } catch (e) {
      this._scheduleReconnect(e.message);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'open';
      this.reconnectAttempt = 0;
      this.stats.connects += 1;
      this.stats.since = Date.now();
      this.logger.info('stream', '实时订单流已连接');
      this._subscribe();
      this._startHeartbeat();
      this.emit('state', this.snapshot());
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      this._handleMessage(msg);
    });

    ws.on('pong', () => {
      this._lastPong = Date.now();
    });

    ws.on('error', (err) => {
      this.stats.lastError = { message: err.message, at: Date.now() };
      this.logger.warn('stream', `实时流错误：${err.message}`);
    });

    ws.on('close', (code, reason) => {
      this.state = 'closed';
      this.stats.subscribed = false;
      this._clearHeartbeat();
      this.emit('state', this.snapshot());
      if (this._stopped) return;
      this.logger.warn('stream', `实时流断开 (${code} ${reason || ''})，准备重连`);
      this._scheduleReconnect(`close ${code}`);
    });
  }

  _subscribe() {
    const g = this.config.get().global;
    const payload = { platform: g.platform || 'pc', crossplay: g.crossplay !== false };
    this._send('@wfm|cmd/subscribe/newOrders', payload);
  }

  _send(route, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._msgId += 1;
    this.ws.send(JSON.stringify({ route, id: `m${this._msgId}`, payload }));
  }

  _handleMessage(msg) {
    const route = msg.route || '';
    if (route.endsWith(':ok')) {
      if (route.includes('subscribe/newOrders')) {
        this.stats.subscribed = true;
        this.logger.info('stream', '已订阅新订单实时推送');
      }
      return;
    }
    if (route === '@wfm|protect/error') {
      this.stats.lastError = { message: `鉴权失败：${msg.payload}`, at: Date.now() };
      return;
    }
    if (route === '@wfm|event/subscriptions/newOrder' && msg.payload) {
      this.stats.events += 1;
      this.stats.lastEventAt = Date.now();
      this.emit('order', msg.payload);
    }
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._lastPong = Date.now();
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch (_) {}
      if (Date.now() - this._lastPong > 90000) {
        this.logger.warn('stream', '心跳超时，强制重连');
        try {
          this.ws.terminate();
        } catch (_) {}
      }
    }, 30000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  _clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  _scheduleReconnect(reason) {
    if (this._stopped) return;
    clearTimeout(this.timer);
    const max = this.config.get().network.streamReconnectMaxSec * 1000;
    this.reconnectAttempt += 1;
    this.stats.reconnects += 1;
    const delay = jitter(Math.min(max, 1000 * 2 ** Math.min(this.reconnectAttempt, 6)), 25);
    this.logger.debug('stream', `${Math.round(delay / 1000)}s 后重连（${reason}）`);
    this.timer = setTimeout(() => this._connect(), delay);
    if (this.timer.unref) this.timer.unref();
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      subscribed: this.stats.subscribed,
      events: this.stats.events,
      connects: this.stats.connects,
      reconnects: this.stats.reconnects,
      lastEventAt: this.stats.lastEventAt,
      lastError: this.stats.lastError,
      uptimeSec: this.stats.since ? Math.round((Date.now() - this.stats.since) / 1000) : 0,
    };
  }
}

module.exports = { OrderStream, WS_URL };
