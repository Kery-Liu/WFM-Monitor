'use strict';

/**
 * 检查更新
 *
 * 为什么自己写 https 而不用 core/http/client.js：
 * 那个客户端把 BASE 绑死在 api.warframe.market，还挂着一个全局令牌桶和熔断器，
 * 把 GitHub/Gitee 的请求混进去会污染监控的限速统计和熔断判定。
 *
 * 为什么 Gitee 在前：实测本机直连 api.github.com 45 秒拿不到响应（http=000），
 * github.com 15 秒超时；Gitee 的 raw 和 Release 附件则完全可达。
 * 两个源都失败时返回 unreachable，不重试、不弹窗、不阻塞窗口显示。
 */

const https = require('https');
const zlib = require('zlib');

const SOURCES = [
  'https://gitee.com/Kery1126/WFM-Monitor/raw/master/update.json',
  // 注意分支名是 master，不是 main。写成 main 会一直 404，
  // 而失败分支只会在设置页显示「暂时无法检查更新」，不会报错，很容易一直没发现。
  'https://raw.githubusercontent.com/Kery-Liu/WFM-Monitor/master/update.json',
];

const TIMEOUT_MS = 3000;
const MAX_REDIRECT = 3;

/** 拉一个 JSON，手动跟随 302（Gitee raw 会跳两次到 raw.giteeusercontent.com） */
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECT) {
      reject(new Error('重定向过多'));
      return;
    }
    let req;
    try {
      req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'WFM-Monitor (update check)',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
          },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            let next;
            try {
              next = new URL(res.headers.location, url).toString();
            } catch (_) {
              reject(new Error('重定向地址无效'));
              return;
            }
            resolve(fetchJson(next, redirects + 1));
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let buf = Buffer.concat(chunks);
            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip' || enc === 'deflate') {
              try {
                buf = enc === 'gzip' ? zlib.gunzipSync(buf) : zlib.inflateSync(buf);
              } catch (_) {
                reject(new Error('响应解压失败'));
                return;
              }
            }
            try {
              resolve(JSON.parse(buf.toString('utf8')));
            } catch (_) {
              reject(new Error('响应不是合法 JSON'));
            }
          });
        }
      );
    } catch (e) {
      reject(e);
      return;
    }
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', (e) => reject(e));
  });
}

/**
 * 语义化版本比较。不能直接用字符串比：'1.1.10' 字面小于 '1.1.5'，
 * 但实际更高。返回 1 / 0 / -1。
 */
function compareVersion(a, b) {
  const parse = (v) =>
    String(v == null ? '' : v)
      .trim()
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((x) => Number.parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * @param {object} p
 * @param {string} p.current  当前版本，如 '1.2.0'
 * @param {Array}  p.sources  按顺序尝试的 update.json 地址
 * @returns {Promise<{state:'available'|'latest'|'unreachable', current, latest?, url?, notes?, source?, errors?}>}
 */
async function check({ current, sources = SOURCES } = {}) {
  const errors = [];
  for (const url of sources) {
    try {
      const data = await fetchJson(url);
      const latest = String((data && data.version) || '').trim();
      if (!latest) throw new Error('缺少 version 字段');
      const cmp = compareVersion(latest, current);
      return {
        state: cmp > 0 ? 'available' : 'latest',
        current,
        latest,
        url: typeof data.url === 'string' ? data.url : '',
        notes: typeof data.notes === 'string' ? data.notes : '',
        force: !!data.force,
        source: url,
      };
    } catch (e) {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch (_) {}
      errors.push(`${host}: ${e.message}`);
    }
  }
  return { state: 'unreachable', current, errors };
}

module.exports = { check, compareVersion, fetchJson, SOURCES };
