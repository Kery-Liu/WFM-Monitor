'use strict';

/**
 * 通用工具层：ID、时间、抖动、原子写入、文本归一化
 */

const fs = require('fs');
const path = require('path');

let _seq = 0;
function uid(prefix = 'id') {
  _seq = (_seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36).padStart(3, '0')}`;
}

const now = () => Date.now();

function jitter(ms, pct = 15) {
  const f = 1 + (Math.random() * 2 - 1) * (pct / 100);
  return Math.max(1000, Math.round(ms * f));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 原子写：先写临时文件再 rename，避免崩溃时半截文件 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    try {
      fs.renameSync(file, `${file}.corrupt.${Date.now()}`);
    } catch (_) {}
    return fallback;
  }
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

/** 保留最后 N 行（用于事件日志滚动） */
function trimLines(file, maxLines) {
  try {
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= maxLines) return;
    fs.writeFileSync(file, `${lines.slice(-maxLines).join('\n')}\n`, 'utf8');
  } catch (_) {}
}

// ---------- 文本归一化 / 模糊匹配 ----------

function normalize(str) {
  return String(str == null ? '' : str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[·・•._\-–—/\\|,，、]+/g, ' ')
    .replace(/[（）()【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const compact = (s) => normalize(s).replace(/\s+/g, '');

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    const m = B.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const n of B.values()) total += n;
  return (2 * inter) / total;
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '--';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

module.exports = {
  uid,
  now,
  jitter,
  clamp,
  sleep,
  writeJsonAtomic,
  readJsonSafe,
  appendLine,
  trimLines,
  normalize,
  compact,
  diceCoefficient,
  fmtDuration,
};
