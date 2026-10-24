'use strict';

/**
 * 独立 HTTP 模式（无 Electron）
 * 用途：1) 无图形环境下调试；2) 想在浏览器里开着用；3) 打包 Electron 前的冒烟测试
 * 用法： node src/server.js  → http://127.0.0.1:17890
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { App } = require('./core/app');

const PORT = Number(process.env.PORT || 17890);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.WFM_DATA || path.join(__dirname, '..', 'data');
const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const app = new App({
  dataDir: DATA_DIR,
  hooks: {
    showDesktop: async (p) => {
      // eslint-disable-next-line no-console
      console.log(`[桌面通知] ${p.title}\n${p.body}\n`);
    },
  },
});

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

const routes = {
  'GET /api/status': () => app.status(),
  'GET /api/settings': () => app.settings(),
  'GET /api/defaults': () => app.getDefaults(),
  'POST /api/reset-settings': () => app.resetSettings(),
  'GET /api/targets': () => app.targets(),
  'GET /api/events': (q) => app.events(Number(q.n) || 200),
  'GET /api/diagnose': () => app.diagnose(),
  'GET /api/attrs': () => app.listAttrs(),
  'GET /api/log': (q) => app.logger.tail(Number(q.n) || 200),

  'POST /api/settings': (q, b) => app.saveSettings(b),
  'POST /api/targets': (q, b) => app.addTarget(b),
  'POST /api/search-items': (q, b) => app.searchItems(b.q || ''),
  'POST /api/search-weapons': (q, b) => app.searchWeapons(b.q || ''),
  'POST /api/check': (q, b) => app.checkNow(b.id),
  'POST /api/check-all': () => app.checkAll(),
  'POST /api/copy-text': () => true,
  'GET /api/control/status': () => app.control.status(),
  'POST /api/control/poll': () => app.control.pollOnce(),
  'GET /api/hotkey-status': () => ({ ok: true, registered: false, accelerator: '', headless: true }),
  'GET /api/item-detail': (q) => app.itemDetail(q.slug),
  'POST /api/update-target': (q, b) => app.updateTarget(b.id, b.patch || {}),
  'POST /api/test-notify': () => app.testNotify(),
  'POST /api/refresh-catalog': () => app.refreshCatalog(),
  'DELETE /api/targets': (q) => app.removeTarget(q.id),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const key = `${req.method} ${p}`;
    const fn = routes[key];
    if (!fn) return json(res, 404, { ok: false, error: { message: 'no route' } });
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const q = Object.fromEntries(url.searchParams.entries());
      const data = await fn(q, body);
      return json(res, 200, { ok: true, data });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        error: { message: e.message, kind: e.kind || null, advice: e.advice || null, code: e.code || null },
      });
    }
  }

  const file = path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  return res.end(buf);
});

app.init().then(() => {
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  WFM Monitor (headless)\n  http://${HOST}:${PORT}\n  data: ${DATA_DIR}\n`);
  });
});

process.on('SIGINT', async () => {
  await app.shutdown();
  process.exit(0);
});
