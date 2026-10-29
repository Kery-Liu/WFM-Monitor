'use strict';

/**
 * 散件对比独立窗口
 *
 * 为什么是独立 BrowserWindow 而不是应用内弹窗：
 * 用户要比价时往往还得回头看监控列表，弹窗会挡住；而且需求要求「能缩到任务栏继续跑」，
 * 应用内那套「最小化」只是隐藏一个 div，做不到。
 *
 * 刻意不设 parent —— 设了就会随主窗口一起最小化/关闭，正好违背使用场景。
 * 标题栏用系统原生的，零成本拿到最小化/最大化/关闭，也不需要新增窗口控制 IPC。
 */

const path = require('path');
const { BrowserWindow } = require('electron');

const MAX_WINDOWS = 4; // 软上限：防止误点出一堆窗口把 IPC 和限速队列拖垮
const windows = new Map(); // slug -> BrowserWindow

function open(slug, meta = {}) {
  if (!slug) return null;

  const existing = windows.get(slug);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  if (windows.size >= MAX_WINDOWS) {
    const first = windows.entries().next().value;
    if (first && first[1] && !first[1].isDestroyed()) {
      if (first[1].isMinimized()) first[1].restore();
      first[1].show();
      first[1].focus();
      return first[1];
    }
  }

  const win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#0b0f14',
    title: meta.title || '散件对比',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // preload 据此只暴露 wfmParts 那套窄接口
      additionalArguments: ['--wfm-window=parts'],
    },
  });

  const query = { slug };
  if (meta.setPrice != null) query.setPrice = String(meta.setPrice);
  if (meta.nameZh) query.zh = String(meta.nameZh);
  if (meta.nameEn) query.en = String(meta.nameEn);
  win.loadFile(path.join(__dirname, '..', '..', 'web', 'parts.html'), { query });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    windows.delete(slug);
  });

  windows.set(slug, win);
  return win;
}

/** 退出时统一关掉，避免 before-quit 之后还有残留窗口挡着进程退出 */
function closeAll() {
  for (const w of windows.values()) {
    if (w && !w.isDestroyed()) {
      w.removeAllListeners('closed');
      w.destroy();
    }
  }
  windows.clear();
}

function count() {
  return windows.size;
}

module.exports = { open, closeAll, count };
