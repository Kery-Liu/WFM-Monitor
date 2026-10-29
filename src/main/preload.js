'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((res) => {
  if (res && res.ok) return res.data;
  const err = new Error(res?.error?.message || '调用失败');
  if (res?.error) {
    err.code = res.error.code || null;
    err.kind = res.error.kind || null;
    err.advice = res.error.advice || null;
    err.candidateCount = res.error.candidateCount || 0;
  }
  throw err;
});

/**
 * 两个窗口共用同一个 preload，但能力面收窄：
 * 散件对比子窗口只需要「取数 / 复制 / 开外链」，拿不到 targets:update、
 * app:save-settings 这类改状态的接口——它的 slug 来自 URL 参数，越小越安全。
 */
const IS_PARTS = process.argv.includes('--wfm-window=parts');

const partsApi = {
  meta: () => invoke('parts:meta'),
  get: (slug, opts) => invoke('parts:get', slug, opts),
  update: (slug, opts) => invoke('parts:update', slug, opts),
  openExternal: (url) => invoke('app:open-external', url),
  copyText: (text) => invoke('app:copy-text', text),
};

const fullApi = {
  status: () => invoke('app:status'),
  diagnose: () => invoke('app:diagnose'),
  settings: () => invoke('app:settings'),
  defaults: () => invoke('app:defaults'),
  resetSettings: () => invoke('app:reset-settings'),
  saveSettings: (patch) => invoke('app:save-settings', patch),
  testNotify: () => invoke('app:test-notify'),
  refreshCatalog: () => invoke('app:refresh-catalog'),
  openExternal: (url) => invoke('app:open-external', url),
  copyText: (text) => invoke('app:copy-text', text),
  hotkeyStatus: () => invoke('app:hotkey-status'),
  controlStatus: () => invoke('control:status'),
  controlPoll: () => invoke('control:poll'),
  hotkeyTest: () => invoke('app:hotkey-test'),
  version: () => invoke('app:version'),
  checkUpdate: (opts) => invoke('app:check-update', opts),
  log: (n) => invoke('app:log', n),

  targets: () => invoke('targets:list'),
  addTarget: (input) => invoke('targets:add', input),
  updateTarget: (id, patch) => invoke('targets:update', id, patch),
  removeTarget: (id) => invoke('targets:remove', id),
  checkNow: (id) => invoke('targets:check-now', id),
  checkAll: () => invoke('targets:check-all'),

  searchItems: (q) => invoke('search:items', q),
  searchWeapons: (q) => invoke('search:weapons', q),
  listAttrs: () => invoke('search:attrs'),
  itemDetail: (slug) => invoke('items:detail', slug),
  itemQuote: (slug) => invoke('items:quote', slug),
  openParts: (meta) => invoke('parts:open', meta),

  events: (n) => invoke('events:list', n),
  clearEvents: () => invoke('events:clear'),
  itemStats: (slug) => invoke('stats:item', slug),

  onPush: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('push', listener);
    return () => ipcRenderer.removeListener('push', listener);
  },
};

contextBridge.exposeInMainWorld(IS_PARTS ? 'wfmParts' : 'wfm', IS_PARTS ? partsApi : fullApi);
