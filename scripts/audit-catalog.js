'use strict';

/**
 * 清单体检脚本
 * 目的：确认「市场里存在的物品」在我们这边没有漏，特别是套装散件。
 * 用法：node scripts/audit-catalog.js
 */

const path = require('path');
const fs = require('fs');

const file = process.argv[2] || path.join(__dirname, '..', 'assets', 'catalog.seed.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const items = data.items || [];
const weapons = data.weapons || [];
const attrs = data.attrs || [];

const bySlug = new Map(items.map((i) => [i.slug, i]));
const byId = new Map(items.map((i) => [i.id, i]));

console.log(`清单来源: ${file}`);
console.log(`抓取时间: ${new Date(data.fetchedAt).toLocaleString('zh-CN')}`);
console.log(`物品 ${items.length} | 紫卡武器 ${weapons.length} | 紫卡词条 ${attrs.length}\n`);

// 1. 按标签分类统计
const tagCount = new Map();
for (const it of items) for (const t of it.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);
console.log('— 物品分类（前 15）—');
console.log(topTags.slice(0, 15).map(([t, n]) => `${t}:${n}`).join('  '));

// 2. 中文名缺失
const noZh = items.filter((i) => !i.zh);
console.log(`\n— 中文名缺失 —\n${noZh.length} 个${noZh.length ? '：' + noZh.slice(0, 10).map((i) => i.slug).join(', ') : ''}`);

// 3. 套装散件完整性
const PART_HINTS = ['blueprint', 'chassis', 'systems', 'neuroptics', 'barrel', 'receiver', 'stock', 'blade', 'handle', 'hilt', 'link', 'upper_limb', 'lower_limb', 'string', 'grip', 'ornament', 'pouch', 'head', 'gauntlet', 'blade', 'disc', 'carapace', 'cerebrum', 'harness', 'wings', 'band', 'buckle'];
const sets = items.filter((i) => /_set$/.test(i.slug));
const missing = [];
const complete = [];
for (const s of sets) {
  const base = s.slug.replace(/_set$/, '');
  const siblings = items.filter((i) => i.slug.startsWith(`${base}_`) && i.slug !== s.slug);
  // 只统计「看起来像散件」的兄弟节点
  const parts = siblings.filter((i) => PART_HINTS.some((h) => i.slug.includes(h)));
  if (parts.length >= 2) complete.push({ slug: s.slug, parts: parts.length });
  else missing.push({ slug: s.slug, zh: s.zh, parts: parts.length, siblings: siblings.slice(0, 3).map((x) => x.slug) });
}
console.log(`\n— 套装散件检查 —`);
console.log(`带 _set 后缀的套装：${sets.length} 个，其中散件齐全(≥2)：${complete.length} 个，疑似缺失：${missing.length} 个`);
if (missing.length) {
  console.log('疑似缺失明细（可能是名称不规则，非真缺）：');
  missing.slice(0, 15).forEach((m) => console.log(`  ${m.slug.padEnd(34)} ${m.zh || ''}  兄弟节点:${m.siblings.join(',') || '无'}`));
}

// 4. 已知问题样本抽查
const SAMPLES = ['mag_prime_set', 'mag_prime_blueprint', 'mag_prime_chassis_blueprint', 'mag_prime_systems_blueprint', 'mag_prime_neuroptics_blueprint', 'ash_prime_set', 'braton_prime_set'];
console.log('\n— 抽查样本 —');
for (const s of SAMPLES) {
  const it = bySlug.get(s);
  console.log(`  ${s.padEnd(32)} ${it ? '✓ ' + (it.zh || it.en) : '✗ 缺失'}`);
}

// 5. 紫卡武器覆盖
const noZhWeapon = weapons.filter((w) => !w.zh);
console.log(`\n— 紫卡武器 —\n共 ${weapons.length} 把，中文名缺失 ${noZhWeapon.length} 把${noZhWeapon.length ? '：' + noZhWeapon.slice(0, 8).map((w) => w.slug).join(', ') : ''}`);

// 6. 重复 slug
const slugCount = new Map();
for (const it of items) slugCount.set(it.slug, (slugCount.get(it.slug) || 0) + 1);
const dup = [...slugCount.entries()].filter(([, n]) => n > 1);
console.log(`\n— 重复 slug —\n${dup.length ? dup.map(([s, n]) => `${s}×${n}`).join(', ') : '无'}`);

// 汇总
const issues = noZh.length + dup.length + missing.length;
console.log(`\n结论：${issues === 0 ? '未发现结构性问题' : `发现 ${issues} 处需关注项（见上）`}。`);
