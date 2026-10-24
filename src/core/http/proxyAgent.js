'use strict';

/**
 * 代理层：支持 HTTP/HTTPS 代理的隧道（CONNECT）
 * 为什么自己写：Node 内置 fetch/https 不会自动走代理，而国内访问国外站点常需要代理，
 * 同时自定义隧道能拿到精确的错误码（区分「代理挂了」和「目标挂了」）。
 */

const https = require('https');
const net = require('net');
const tls = require('tls');

class ProxyAgent extends https.Agent {
  constructor(proxyUrl, opts = {}) {
    super({ keepAlive: true, maxSockets: 4, ...opts });
    this.proxy = new URL(proxyUrl);
    this.timeoutMs = opts.proxyTimeoutMs || 15000;
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = Number(options.port) || 443;
    const proxyPort = Number(this.proxy.port) || (this.proxy.protocol === 'https:' ? 443 : 80);

    let settled = false;
    const done = (err, sock) => {
      if (settled) return;
      settled = true;
      callback(err, sock);
    };

    const socket = net.connect({ host: this.proxy.hostname, port: proxyPort });
    socket.setTimeout(this.timeoutMs, () => {
      const e = new Error('代理连接超时');
      e.code = 'PROXY_CONNECT_FAILED';
      socket.destroy();
      done(e);
    });
    socket.on('error', (e) => {
      if (!e.code || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        const err = new Error(`无法连接代理 ${this.proxy.hostname}:${proxyPort} (${e.code || e.message})`);
        err.code = 'PROXY_CONNECT_FAILED';
        return done(err);
      }
      return done(e);
    });
    socket.on('connect', () => {
      let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (this.proxy.username) {
        const cred = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password || '')}`;
        req += `Proxy-Authorization: Basic ${Buffer.from(cred).toString('base64')}\r\n`;
      }
      req += 'Proxy-Connection: keep-alive\r\n\r\n';
      socket.write(req);
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16384) {
          socket.destroy();
          const e = new Error('代理响应异常');
          e.code = 'PROXY_CONNECT_FAILED';
          done(e);
        }
        return;
      }
      socket.removeListener('data', onData);
      const head = buf.slice(0, idx).toString('latin1');
      const m = head.match(/^HTTP\/1\.[01]\s+(\d{3})/);
      if (!m || m[1] !== '200') {
        socket.destroy();
        const e = new Error(`代理拒绝隧道：${head.split('\r\n')[0]}`);
        e.code = 'PROXY_CONNECT_FAILED';
        return done(e);
      }
      const rest = buf.slice(idx + 4);
      if (rest.length) socket.unshift(rest);

      const tlsOpts = { socket, servername: targetHost };
      if (options.rejectUnauthorized === false) tlsOpts.rejectUnauthorized = false;
      const tlsSock = tls.connect(tlsOpts, () => done(null, tlsSock));
      tlsSock.on('error', (e) => done(e));
      return undefined;
    };
    socket.on('data', onData);
    return undefined;
  }
}

module.exports = { ProxyAgent };
