'use strict';

/**
 * 领域层 - 关键词解析器（需求 5 的核心）
 *
 * 现实问题：市场里的物品是「客观存在且拼写固定」的，用户输入是「主观且随意」的。
 * 所以不能直接拿用户输入去请求接口，必须先做「输入 → 候选物品」的解析：
 *   1) 归一化：全角转半角、去标点、大小写
 *   2) 别名扩展：p→prime、一套/套/set、蓝图/图/bp
 *   3) 多字段打分：slug / 英文名 / 中文名，取最高分再叠加语义修正
 *   4) IDF 加权：prime / set / blueprint 这类高频词权重低，物品专名权重高，
 *      避免「ash prime 一套」把一堆无关的 Prime 套装也排上来
 *   5) 核心词门槛：查询里最稀有的那个词必须命中，否则大幅降权
 *   6) 永不静默替换：永远返回候选列表 + 置信度，让用户确认
 */

const { normalize, compact, diceCoefficient } = require('../util');

const ALIASES = {
  p: 'prime',
  pr: 'prime',
  prime: 'prime',
  一套: 'set',
  套: 'set',
  整套: 'set',
  set: 'set',
  full: 'set',
  蓝图: 'blueprint',
  图: 'blueprint',
  蓝纸: 'blueprint',
  bp: 'blueprint',
  blueprint: 'blueprint',
};

/** 扩展查询词：把口语别名展开成清单里的规范词 */
function expandQuery(raw) {
  const norm = normalize(raw);
  const rawTokens = norm.split(' ').filter(Boolean);
  const tokens = [];
  const flags = { wantsSet: false, wantsBlueprint: false };

  for (const t of rawTokens) {
    if (ALIASES[t]) {
      const a = ALIASES[t];
      if (a === 'set') flags.wantsSet = true;
      if (a === 'blueprint') flags.wantsBlueprint = true;
      tokens.push(a);
      continue;
    }
    if (/套$/.test(t) && t.length > 1) {
      flags.wantsSet = true;
      tokens.push(t.replace(/套$/, ''), 'set');
      continue;
    }
    if (/(蓝图|图)$/.test(t) && t.length > 2) {
      flags.wantsBlueprint = true;
      tokens.push(t.replace(/(蓝图|图)$/, ''), 'blueprint');
      continue;
    }
    tokens.push(t);
  }

  return { norm, tokens: tokens.filter(Boolean), flags };
}

function isCJK(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

/**
 * 单词级相似度
 * 关键约束（踩过的坑）：
 *   "mag" 不能匹配 "magnus" / "magazine" —— 早期用「前缀命中即 0.86」，
 *   导致 mag prime 搜出来的全是麦格努斯和 Primed 弹匣 MOD，真正的散件被挤掉。
 * 规则：英文前缀匹配要求查询词占目标词长度的 75% 以上；中文按包含判断。
 */
function tokenScore(qt, ft) {
  if (qt === ft) return 1;

  if (isCJK(qt) || isCJK(ft)) {
    if (ft.includes(qt) && qt.length >= 2) return 0.9;
    if (qt.includes(ft) && ft.length >= 2) return 0.82;
  } else {
    if (ft.startsWith(qt) && qt.length / ft.length >= 0.75) return 0.9;
    if (qt.startsWith(ft) && ft.length / qt.length >= 0.75) return 0.84;
    if (ft.includes(qt) && qt.length / ft.length >= 0.8) return 0.72;
  }

  const d = diceCoefficient(qt, ft);
  return d >= 0.78 ? 0.6 * d : 0;
}

function tokenize(text) {
  return normalize(text).split(' ').filter(Boolean);
}

function semanticAdjust(score, queryInfo, item) {
  let s = score;
  const name = normalize(`${item.en} ${item.zh}`);
  const isBlueprint = /blueprint|蓝图/.test(name);
  const isSet = item.setRoot || /一套|(^|\s)set(\s|$)/.test(normalize(`${item.zh} ${item.en}`));

  if (queryInfo.flags.wantsSet) s *= isSet ? 1.12 : 0.88;
  if (queryInfo.flags.wantsBlueprint) s *= isBlueprint ? 1.15 : 0.9;
  // 没说要蓝图时给一点降权即可，压太狠会把散件挤出候选（mag prime 的教训）
  if (!queryInfo.flags.wantsBlueprint && isBlueprint) s *= 0.84;
  if (!queryInfo.flags.wantsSet && isSet) s *= 1.05;
  return s;
}

function confidenceOf(score, secondScore) {
  if (score >= 950) return 'exact';
  if (score >= 720 && (secondScore == null || score - secondScore >= 60)) return 'strong';
  if (score >= 420) return 'weak';
  return 'none';
}

class Resolver {
  constructor({ catalog }) {
    this.catalog = catalog;
    this._index = { items: null, weapons: null };
  }

  /** 词频索引：用来计算 IDF 权重 */
  _ensureIndex(list, key) {
    if (this._index[key]) return this._index[key];
    const df = new Map();
    let n = 0;
    for (const it of list) {
      n += 1;
      const toks = new Set([...tokenize(it.en || ''), ...tokenize(it.zh || ''), ...tokenize((it.slug || '').replace(/_/g, ' '))]);
      for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
    }
    this._index[key] = { df, n: Math.max(1, n) };
    return this._index[key];
  }

  _weight(token, idx) {
    const df = idx.df.get(token) || 1;
    return Math.log(1 + idx.n / (1 + df));
  }

  /** 对单个候选文本打分 */
  _score(queryInfo, text, idx) {
    const fc = compact(text);
    if (!fc) return 0;
    const qc = compact(queryInfo.norm);
    let best = 0;

    if (qc && fc === qc) best = 1000;
    else if (qc && fc.startsWith(qc)) best = 840 - Math.min(140, (fc.length - qc.length) * 6);
    else if (qc && qc.startsWith(fc) && fc.length >= 3) best = 690;
    else if (qc && fc.includes(qc)) best = 620 - Math.min(120, fc.indexOf(qc) * 3);
    else if (qc && qc.includes(fc) && fc.length >= 4) best = 540;

    const fTokens = tokenize(text);
    if (queryInfo.tokens.length && fTokens.length) {
      let sum = 0;
      let total = 0;
      let coreMatch = 1;
      let coreWeight = -1;
      for (const qt of queryInfo.tokens) {
        const w = this._weight(qt, idx);
        total += w;
        let m = 0;
        for (const ft of fTokens) m = Math.max(m, tokenScore(qt, ft));
        if (w > coreWeight) {
          coreWeight = w;
          coreMatch = m;
        }
        sum += w * m;
      }
      const coverage = total ? sum / total : 0;
      let tokenPart = coverage * 820;
      // 核心词（最稀有的那个词）没命中 → 说明大概率不是同一个东西
      if (coreMatch < 0.5) tokenPart *= 0.28;
      best = Math.max(best, tokenPart);
    }

    return Math.max(best, diceCoefficient(qc, fc) * 380);
  }

  searchItems(raw, limit = 8) {
    const q = expandQuery(raw);
    if (!q.norm) return { query: q, candidates: [], best: null, confidence: 'none' };
    const list = this.catalog.items();
    const idx = this._ensureIndex(list, 'items');

    const scored = [];
    for (const it of list) {
      const s = Math.max(
        this._score(q, it.en, idx),
        this._score(q, it.zh, idx),
        this._score(q, it.slug.replace(/_/g, ' '), idx)
      );
      if (s < 230) continue;
      scored.push({ ...it, score: Math.round(semanticAdjust(s, q, it)) });
    }
    scored.sort((a, b) => b.score - a.score || a.en.length - b.en.length);
    const top = scored.slice(0, limit);
    const best = top[0] || null;
    return {
      query: q,
      candidates: top,
      best,
      confidence: best ? confidenceOf(best.score, top[1] ? top[1].score : null) : 'none',
    };
  }

  searchWeapons(raw, limit = 8) {
    const q = expandQuery(raw);
    if (!q.norm) return { query: q, candidates: [], best: null, confidence: 'none' };
    const list = this.catalog.weapons();
    const idx = this._ensureIndex(list, 'weapons');

    const scored = [];
    for (const w of list) {
      const s = Math.max(
        this._score(q, w.en, idx),
        this._score(q, w.zh, idx),
        this._score(q, w.slug.replace(/_/g, ' '), idx)
      );
      if (s < 230) continue;
      const boost = w.disposition ? 1 + Math.min(0.05, Math.max(0, (w.disposition - 1) * 0.04)) : 1;
      scored.push({ ...w, score: Math.round(s * boost) });
    }
    scored.sort((a, b) => b.score - a.score || a.en.length - b.en.length);
    const top = scored.slice(0, limit);
    const best = top[0] || null;
    return {
      query: q,
      candidates: top,
      best,
      confidence: best ? confidenceOf(best.score, top[1] ? top[1].score : null) : 'none',
    };
  }

  searchAttrs(raw, limit = 12) {
    const q = expandQuery(raw);
    const list = this.catalog.attrs();
    if (!q.norm) return list.slice(0, limit).map((a) => ({ ...a, score: 0 }));
    const idx = this._ensureIndex(list, 'attrs');
    const scored = [];
    for (const a of list) {
      const s = Math.max(this._score(q, a.en, idx), this._score(q, a.zh, idx), this._score(q, a.slug.replace(/_/g, ' '), idx));
      if (s < 200) continue;
      scored.push({ ...a, score: Math.round(s) });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit);
  }

  attrBySlug(slug) {
    return this.catalog.attrs().find((a) => a.slug === slug) || null;
  }
}

module.exports = { Resolver, expandQuery };
