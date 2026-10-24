'use strict';

/**
 * 回复邮件的内容编排
 * 规则（用户明确要求）：有达标就报达标；没达标也必须回一封信，
 * 把所有目标的当前最低价 / 目标价 / 差价列清楚。
 */

function fmtP(n) {
  return n == null ? '--' : `${n}p`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 依据方向算差价：正数=已经优于目标 */
function gapOf(row) {
  if (row.bestPrice == null) return null;
  return row.direction === 'sell' ? row.bestPrice - row.targetPrice : row.targetPrice - row.bestPrice;
}

function stateTag(row, lang) {
  const en = lang === 'en';
  if (!row.enabled) return en ? 'disabled' : '停用';
  if (row.state === 'error') return en ? 'error' : '异常';
  if (row.matched) return en ? 'HIT' : '达标';
  return en ? 'below' : '未达标';
}

function summarize(rows, lang) {
  const en = lang === 'en';
  const total = rows.length;
  const hit = rows.filter((r) => r.enabled && r.matched).length;
  const disabled = rows.filter((r) => !r.enabled).length;
  const errored = rows.filter((r) => r.enabled && r.state === 'error').length;
  return {
    total,
    hit,
    disabled,
    errored,
    line: en
      ? `${hit}/${total} monitors hit · ${disabled} disabled · ${errored} error`
      : `${hit}/${total} 个达标 · ${disabled} 个停用 · ${errored} 个异常`,
  };
}

function sortRows(rows) {
  // 达标 → 正常 → 停用 → 异常
  const rank = (r) => (!r.enabled ? 2 : r.state === 'error' ? 3 : r.matched ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.bestPrice ?? 1e9) - (b.bestPrice ?? 1e9));
}

function buildText(rows, lang, meta) {
  const en = lang === 'en';
  const s = summarize(rows, lang);
  const out = [];
  out.push(meta.title);
  out.push('='.repeat(46));
  out.push(s.line);
  if (meta.note) out.push(meta.note);
  out.push('');
  for (const r of sortRows(rows)) {
    const gap = gapOf(r);
    const gapText = gap == null ? '' : `${gap >= 0 ? '+' : '-'}${Math.abs(gap)}p`;
    const cond = r.direction === 'sell' && r.kind !== 'auction' ? '≥' : '≤';
    out.push(
      `[${stateTag(r, lang)}] ${r.label}\n` +
        `    ${en ? 'now' : '当前'} ${fmtP(r.bestPrice)}  /  ${en ? 'target' : '目标'} ${cond}${fmtP(r.targetPrice)}` +
        (gapText ? `  /  ${en ? 'gap' : '差价'} ${gapText}` : '')
    );
  }
  out.push('');
  out.push(en ? `Checked at ${meta.time}` : `检查时间：${meta.time}`);
  out.push(en ? '— WFM Monitor' : '—— WFM 价格监控');
  return out.join('\n');
}

function buildHtml(rows, lang, meta) {
  const en = lang === 'en';
  const s = summarize(rows, lang);
  const cond = (r) => (r.direction === 'sell' && r.kind !== 'auction' ? '≥' : '≤');

  const trs = sortRows(rows)
    .map((r) => {
      const gap = gapOf(r);
      const hit = r.enabled && r.matched;
      const tag = stateTag(r, lang);
      const tagColor = hit ? '#0f766e' : !r.enabled ? '#8a95a3' : r.state === 'error' ? '#c93a3a' : '#41505f';
      const gapText = gap == null ? '--' : `${gap >= 0 ? '+' : '-'}${Math.abs(gap)}p`;
      const gapColor = gap == null ? '#8a95a3' : gap >= 0 ? '#0f766e' : '#c93a3a';
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #eef2f6;font-size:13px;color:${tagColor};white-space:nowrap">${escapeHtml(tag)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f6;font-size:13px;color:#16202b">${escapeHtml(r.label)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef2f6;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:#16202b">${fmtP(r.bestPrice)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eef2f6;font-size:13px;text-align:right;color:#74808d">${cond(r)}${fmtP(r.targetPrice)}</td>
        <td style="padding:8px 0 8px 10px;border-bottom:1px solid #eef2f6;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:${gapColor}">${gapText}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px 12px;background:#eef2f7;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.08)">
    <tr><td style="background:#111a24;padding:16px 22px">
      <div style="color:#e0b354;font-size:12px;letter-spacing:2px;text-transform:uppercase">WFM Monitor</div>
      <div style="color:#fff;font-size:17px;font-weight:600;margin-top:4px">${escapeHtml(meta.title)}</div>
    </td></tr>
    <tr><td style="padding:20px 22px">
      <div style="font-size:13px;color:#41505f;margin-bottom:${rows.length ? '14px' : '0'}">${escapeHtml(s.line)}</div>
      ${meta.note ? `<div style="font-size:12.5px;color:#74808d;margin-bottom:12px">${escapeHtml(meta.note)}</div>` : ''}
      ${
        rows.length
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <th align="left" style="font-size:11px;color:#8a95a3;font-weight:500;padding-bottom:6px">${en ? 'state' : '状态'}</th>
                <th align="left" style="font-size:11px;color:#8a95a3;font-weight:500;padding:0 10px 6px">${en ? 'item' : '物品'}</th>
                <th align="right" style="font-size:11px;color:#8a95a3;font-weight:500;padding-bottom:6px">${en ? 'now' : '当前'}</th>
                <th align="right" style="font-size:11px;color:#8a95a3;font-weight:500;padding-bottom:6px">${en ? 'target' : '目标'}</th>
                <th align="right" style="font-size:11px;color:#8a95a3;font-weight:500;padding:0 0 6px 10px">${en ? 'gap' : '差价'}</th>
              </tr>
              ${trs}
            </table>`
          : `<div style="padding:18px 0;color:#74808d;font-size:13px">${en ? 'No monitors yet.' : '还没有任何监控目标。'}</div>`
      }
      <div style="margin-top:16px;color:#93a1af;font-size:11.5px">${escapeHtml(en ? `Checked at ${meta.time}` : `检查时间：${meta.time}`)}</div>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * @param {object} opts
 * @param {'check'|'status'|'help'} opts.mode
 * @param {'zh'|'en'} opts.lang
 * @param {Array} opts.rows 每行 { label, enabled, state, kind, direction, bestPrice, targetPrice, matched }
 * @param {string} [opts.note] 附加说明（如"已跳过 N 个停用目标"）
 */
function buildReply({ mode, lang = 'zh', rows = [], note = '', elapsed = 0, checkedAt = Date.now() }) {
  const en = lang === 'en';
  const time = new Date(checkedAt).toLocaleString(en ? 'en-US' : 'zh-CN');
  const s = summarize(rows, lang);

  if (mode === 'help') {
    return {
      subject: en ? '[WFM] Available commands' : '【WFM】可用指令',
      text: require('./commands').helpText(lang),
      html: `<pre style="font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.8;color:#16202b">${escapeHtml(
        require('./commands').helpText(lang)
      )}</pre>`,
    };
  }

  const title =
    mode === 'check'
      ? en
        ? `Check finished · ${s.hit}/${s.total} hit`
        : `检查完成 · ${s.hit}/${s.total} 达标`
      : en
        ? `Current status · ${s.total} monitors`
        : `当前状态 · ${s.total} 个目标`;

  const subject =
    mode === 'check'
      ? en
        ? `[WFM] Check done · ${s.hit}/${s.total} hit`
        : `【WFM】检查完成 · ${s.hit}/${s.total} 达标`
      : en
        ? `[WFM] Status · ${s.total} monitors`
        : `【WFM】当前状态 · ${s.total} 个目标`;

  const meta = { title, note, time };
  return { subject, text: buildText(rows, lang, meta), html: buildHtml(rows, lang, meta), summary: s, elapsed };
}

module.exports = { buildReply, gapOf, summarize, stateTag, fmtP };
