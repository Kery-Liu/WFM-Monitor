'use strict';

/**
 * 统一错误分类层
 * 目标：把底层网络/HTTP 异常翻译成「人话 + 处置建议」，供 UI 直接展示。
 */

const KINDS = {
  DNS: 'dns',
  CONNECT: 'connect',
  TLS: 'tls',
  TIMEOUT: 'timeout',
  PROXY: 'proxy',
  OFFLINE: 'offline',
  CLOUDFLARE: 'cloudflare',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  TOO_MANY_CONN: 'too_many_conn',
  NOT_FOUND: 'not_found',
  SERVER: 'server',
  BAD_RESPONSE: 'bad_response',
  SCHEMA: 'schema',
  UNKNOWN: 'unknown',
};

const ADVICE = {
  [KINDS.DNS]: 'DNS 解析失败：检查网络是否连通；若使用代理，确认代理软件正在运行且 DNS 走代理。',
  [KINDS.CONNECT]: '无法建立 TCP 连接：目标不可达。检查防火墙/代理端口，或稍后重试。',
  [KINDS.TLS]: 'TLS 握手失败：多为代理中间人证书或系统时间错误。关闭代理的 HTTPS 解密，或校准系统时间。',
  [KINDS.TIMEOUT]: '请求超时：跨国链路抖动或代理拥塞。可提高超时时间、降低刷新频率、换用稳定代理。',
  [KINDS.PROXY]: '代理连接失败：检查代理地址/端口/账号密码是否正确。',
  [KINDS.OFFLINE]: '本机似乎没有网络。检查网卡与路由器。',
  [KINDS.CLOUDFLARE]: '被 Cloudflare 拦截（人机验证/风控）。本程序只调用官方 API、不抓取网页，正常不会触发；出现时通常是出口 IP 被标记。处理：1) 关闭/更换代理节点；2) 降低轮询频率；3) 打开浏览器访问 warframe.market 手动通过一次验证；4) 等待 10-30 分钟再试。',
  [KINDS.FORBIDDEN]: '服务端拒绝访问（403）。可能触发风控或接口权限变更。降低频率并稍后重试。',
  [KINDS.RATE_LIMITED]: '触发速率限制（429）。官方上限 3 请求/秒，程序会自动降速冷却，无需干预。',
  [KINDS.TOO_MANY_CONN]: '并发连接过多（509）。程序会自动减少并发并重试。',
  [KINDS.NOT_FOUND]: '目标资源不存在：可能是物品名/URL 标识错误，或该物品已下架。',
  [KINDS.SERVER]: 'warframe.market 服务端异常（5xx）。属于对方问题，程序会退避重试。',
  [KINDS.BAD_RESPONSE]: '响应不是合法 JSON：多为被网关/代理劫持或返回了拦截页。',
  [KINDS.SCHEMA]: '响应结构不符合预期：接口可能已升级，请更新程序。',
  [KINDS.UNKNOWN]: '未知错误，详见日志。',
};

class AppError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.status = extra.status || null;
    this.retryable = extra.retryable !== undefined ? extra.retryable : defaultRetryable(kind);
    this.advice = extra.advice || ADVICE[kind] || ADVICE[KINDS.UNKNOWN];
    this.cause = extra.cause || null;
    this.code = extra.code || null;
    this.detail = extra.detail || null;
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      advice: this.advice,
      code: this.code,
      detail: this.detail,
    };
  }
}

function defaultRetryable(kind) {
  return [
    KINDS.TIMEOUT,
    KINDS.CONNECT,
    KINDS.RESET,
    KINDS.SERVER,
    KINDS.RATE_LIMITED,
    KINDS.TOO_MANY_CONN,
    KINDS.BAD_RESPONSE,
  ].includes(kind);
}

/** 把 Node 的 socket 错误码映射成分类 */
function fromNodeError(err, ctx = {}) {
  const code = err && err.code;
  const map = {
    ENOTFOUND: KINDS.DNS,
    EAI_AGAIN: KINDS.DNS,
    EAI_NONAME: KINDS.DNS,
    ECONNREFUSED: KINDS.CONNECT,
    EHOSTUNREACH: KINDS.CONNECT,
    ENETUNREACH: KINDS.OFFLINE,
    ENETDOWN: KINDS.OFFLINE,
    ECONNRESET: KINDS.CONNECT,
    EPIPE: KINDS.CONNECT,
    ETIMEDOUT: KINDS.TIMEOUT,
    ESOCKETTIMEDOUT: KINDS.TIMEOUT,
    PROXY_CONNECT_FAILED: KINDS.PROXY,
    CERT_HAS_EXPIRED: KINDS.TLS,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: KINDS.TLS,
    SELF_SIGNED_CERT_IN_CHAIN: KINDS.TLS,
    DEPTH_ZERO_SELF_SIGNED_CERT: KINDS.TLS,
    ERR_TLS_CERT_ALTNAME_INVALID: KINDS.TLS,
  };
  const kind = map[code] || KINDS.UNKNOWN;
  return new AppError(kind, `${ctx.label || '请求'}失败：${err.message}`, {
    code,
    cause: err,
  });
}

/** 根据 HTTP 状态码 + 响应体判断 */
function fromHttpStatus(status, body, ctx = {}) {
  const text = typeof body === 'string' ? body.slice(0, 2000) : '';
  const looksHtml = /^\s*<(!doctype|html)/i.test(text);
  const cfMark = /cloudflare|just a moment|cf-challenge|__CF\$cv\$params|Attention Required/i.test(text);

  if (status === 403 && (cfMark || looksHtml)) {
    return new AppError(KINDS.CLOUDFLARE, 'Cloudflare 拦截了本次请求', { status, detail: text.slice(0, 200) });
  }
  if (status === 403) return new AppError(KINDS.FORBIDDEN, '请求被拒绝 (403)', { status });
  if (status === 429) return new AppError(KINDS.RATE_LIMITED, '触发限速 (429)', { status });
  if (status === 509) return new AppError(KINDS.TOO_MANY_CONN, '并发连接过多 (509)', { status });
  if (status === 404) return new AppError(KINDS.NOT_FOUND, `资源不存在 (404) ${ctx.path || ''}`, { status });
  if (status >= 500) return new AppError(KINDS.SERVER, `服务端错误 (${status})`, { status });
  if (status >= 400) return new AppError(KINDS.FORBIDDEN, `请求失败 (${status})`, { status });
  if (looksHtml) return new AppError(KINDS.BAD_RESPONSE, '返回了 HTML 而非 JSON，疑似被拦截页替换', { status });
  return new AppError(KINDS.BAD_RESPONSE, `异常响应 (${status})`, { status });
}

module.exports = { AppError, KINDS, ADVICE, fromNodeError, fromHttpStatus };
