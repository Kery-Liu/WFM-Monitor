'use strict';

/**
 * 重新生成随包清单快照 assets/catalog.seed.json
 *
 * 用途：官方清单（物品 / 紫卡武器 / 词条）更新后，刷新首启离线数据。
 * 关键：必须带 Language: zh-hans，否则 API 只返回英文名。
 *
 *   node scripts/build-seed.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'catalog.seed.json');
const SCHEMA_VERSION = 2;
const BASE = 'https://api.warframe.market';
const UA = 'WFM-Monitor/1.0 (personal price watcher; contact: local)';

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Language: 'zh-hans' },
  });
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  return res.json();
}

const normalizeThumb = (p) => (p && !/items\/unknown(\.thumb)?\.[a-z]+$/i.test(p) ? p : '');

(async () => {
  console.log('拉取官方清单…');
  const [itemsRes, weaponsRes, attrsRes] = await Promise.all([
    getJson('/v2/items'),
    getJson('/v2/riven/weapons'),
    getJson('/v2/riven/attributes'),
  ]);

  const items = (itemsRes.data || [])
    .filter((it) => it.tradable !== false)
    .map((it) => ({
      id: it.id,
      slug: it.slug,
      en: it.i18n?.en?.name || it.slug,
      zh: it.i18n?.['zh-hans']?.name || '',
      tags: it.tags || [],
      thumb: normalizeThumb(it.i18n?.en?.thumb),
      subIcon: it.i18n?.en?.subIcon || '',
      setRoot: !!it.setRoot,
      setParts: it.setParts || [],
      maxRank: it.maxRank ?? null,
      ducats: it.ducats ?? null,
      mr: it.reqMasteryRank ?? null,
      vaulted: !!it.vaulted,
      subtypes: it.subtypes || [],
    }));

  const weapons = (weaponsRes.data || []).map((w) => ({
    id: w.id,
    slug: w.slug,
    en: w.i18n?.en?.name || w.slug,
    zh: w.i18n?.['zh-hans']?.name || '',
    group: w.group || '',
    rivenType: w.rivenType || '',
    disposition: w.disposition ?? null,
    mr: w.reqMasteryRank ?? null,
  }));

  const attrs = (attrsRes.data || []).map((a) => ({
    slug: a.slug,
    en: a.i18n?.en?.name || a.slug,
    zh: a.i18n?.['zh-hans']?.name || '',
    group: a.group || 'default',
    exclusiveTo: a.exclusiveTo || [],
    positiveOnly: !!a.positiveOnly,
    negativeOnly: !!a.negativeOnly,
  }));

  const missingZh = items.filter((i) => !i.zh).length;
  const out = { schema: SCHEMA_VERSION, fetchedAt: Date.now(), items, weapons, attrs };
  // 2 空格缩进：物品按行排布，日后官方字段变化时 git diff 看得清
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`已写入 ${path.relative(ROOT, OUT)}：物品 ${items.length} / 武器 ${weapons.length} / 词条 ${attrs.length}`);
  console.log(`中文名缺失 ${missingZh} 条；文件 ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
})().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
