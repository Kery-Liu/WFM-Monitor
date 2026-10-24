'use strict';

/**
 * 数据源层 - 清单（catalog）
 * 拉取并缓存三类静态清单：可交易物品 / 紫卡武器 / 紫卡词条
 * 这些清单变动很慢，缓存 12 小时，只在后台静默刷新。
 */

const path = require('path');
const fs = require('fs');
const { readJsonSafe, writeJsonAtomic } = require('../util');

const ASSET_BASE = 'https://warframe.market/static/assets/';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const SEED_FILE = path.join(__dirname, '..', '..', '..', 'assets', 'catalog.seed.json');

class Catalog {
  constructor({ client, logger, dataDir }) {
    this.client = client;
    this.logger = logger;
    this.file = path.join(dataDir, 'catalog.json');
    // 首次启动：把随包附带的清单快照种进去，用户不用等首次联网就能搜物品
    try {
      if (!fs.existsSync(this.file) && fs.existsSync(SEED_FILE)) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.copyFileSync(SEED_FILE, this.file);
      }
    } catch (_) {}
    this.data = readJsonSafe(this.file, null);
    this.loading = null;
    this.lastError = null;
  }

  get ready() {
    return !!(this.data && this.data.items && this.data.items.length);
  }

  get ageMs() {
    return this.data ? Date.now() - this.data.fetchedAt : Infinity;
  }

  async ensureFresh(force = false) {
    if (!force && this.ready && this.ageMs < CACHE_TTL_MS) return this.data;
    if (this.loading) return this.loading;
    this.loading = this._load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async _load() {
    try {
      this.logger.info('catalog', '正在刷新物品清单…');
      const [itemsRes, weaponsRes, attrsRes] = await Promise.all([
        this.client.request('/v2/items', { priority: 1, retries: 2 }),
        this.client.request('/v2/riven/weapons', { priority: 1, retries: 2 }),
        this.client.request('/v2/riven/attributes', { priority: 1, retries: 2 }),
      ]);

      const items = (itemsRes.json.data || [])
        .filter((it) => it.tradable !== false)
        .map((it) => ({
          id: it.id,
          slug: it.slug,
          en: it.i18n?.en?.name || it.slug,
          zh: it.i18n?.['zh-hans']?.name || '',
          tags: it.tags || [],
          thumb: it.i18n?.en?.thumb || '',
          setRoot: !!it.setRoot,
          setParts: it.setParts || [],
          maxRank: it.maxRank ?? null,
          ducats: it.ducats ?? null,
          mr: it.reqMasteryRank ?? null,
          vaulted: !!it.vaulted,
          subtypes: it.subtypes || [],
        }));

      const weapons = (weaponsRes.json.data || []).map((w) => ({
        id: w.id,
        slug: w.slug,
        en: w.i18n?.en?.name || w.slug,
        zh: w.i18n?.['zh-hans']?.name || '',
        group: w.group || '',
        rivenType: w.rivenType || '',
        disposition: w.disposition ?? null,
        mr: w.reqMasteryRank ?? null,
      }));

      const attrs = (attrsRes.json.data || []).map((a) => ({
        slug: a.slug,
        en: a.i18n?.en?.name || a.slug,
        zh: a.i18n?.['zh-hans']?.name || '',
        group: a.group || 'default',
        exclusiveTo: a.exclusiveTo || [],
        positiveOnly: !!a.positiveOnly,
        negativeOnly: !!a.negativeOnly,
      }));

      this.data = { fetchedAt: Date.now(), items, weapons, attrs };
      writeJsonAtomic(this.file, this.data);
      this.logger.info('catalog', `清单已更新：物品 ${items.length} / 紫卡武器 ${weapons.length} / 词条 ${attrs.length}`);
      this.lastError = null;
      return this.data;
    } catch (e) {
      this.lastError = e.toJSON ? e.toJSON() : { message: e.message };
      this.logger.warn('catalog', `清单刷新失败：${e.message}`);
      if (this.ready) return this.data; // 有旧缓存就先用旧的
      throw e;
    }
  }

  items() {
    return this.data?.items || [];
  }

  weapons() {
    return this.data?.weapons || [];
  }

  attrs() {
    return this.data?.attrs || [];
  }

  bySlug(slug) {
    if (!slug) return null;
    return this.items().find((i) => i.slug === slug) || null;
  }

  byId(id) {
    if (!id) return null;
    return this.items().find((i) => i.id === id) || null;
  }

  weaponBySlug(slug) {
    return this.weapons().find((w) => w.slug === slug) || null;
  }

  iconUrl(relPath) {
    if (!relPath) return '';
    return `${ASSET_BASE}${relPath}`;
  }

  snapshotMeta() {
    return {
      ready: this.ready,
      fetchedAt: this.data?.fetchedAt || 0,
      counts: {
        items: this.items().length,
        weapons: this.weapons().length,
        attrs: this.attrs().length,
      },
      lastError: this.lastError,
    };
  }
}

module.exports = { Catalog, ASSET_BASE };
