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

contextBridge.exposeInMainWorld('wfm', {
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

  events: (n) => invoke('events:list', n),
  clearEvents: () => invoke('events:clear'),
  itemStats: (slug) => invoke('stats:item', slug),

  onPush: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('push', listener);
    return () => ipcRenderer.removeListener('push', listener);
  },
});
