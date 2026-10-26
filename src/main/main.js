'use strict';

/**
 * Electron 主进程
 * 只做三件事：开窗口、桥接 IPC、把「通知」落到 Windows 原生 toast。
 * 所有业务逻辑都在 core 层，换 UI（网页/CLI）可原样复用。
 */

const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, shell, nativeImage, dialog, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { App } = require('../core/app');

app.setAppUserModelId('com.kery.wfmmarket.monitor');

const isDev = !app.isPackaged;
let win = null;
let tray = null;
let core = null;
let quitting = false;

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function iconPath() {
  const candidates = [
    path.join(__dirname, '../../assets/icon.png'),
    path.join(process.resourcesPath || '', 'assets/icon.png'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function uiLang() {
  try {
    return core && core.config.get().ui && core.config.get().ui.language === 'en' ? 'en' : 'zh';
  } catch (_) {
    return 'zh';
  }
}

const TT = (zh, en) => (uiLang() === 'en' ? en : zh);

let hotkeyState = { ok: true, registered: false, accelerator: '' };

/** 注册/重注册全局快捷键；返回状态给渲染层展示 */
function applyHotkey() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
  hotkeyState = { ok: true, registered: false, accelerator: '' };
  const cfg = core && core.config.get().ui && core.config.get().ui.hotkey;
  const acc = cfg && cfg.accelerator ? String(cfg.accelerator).trim() : '';
  hotkeyState.accelerator = acc;
  if (!cfg || !cfg.enabled || !acc) return hotkeyState;
  try {
    const ok = globalShortcut.register(acc, () => broadcast('hotkey-fired', { accelerator: acc }));
    hotkeyState = ok
      ? { ok: true, registered: true, accelerator: acc }
      : { ok: false, registered: false, accelerator: acc, error: 'conflict' };
    if (core) core.logger.info('app', `全局快捷键 ${acc}：${ok ? '注册成功' : '注册失败（可能被其他程序占用）'}`);
  } catch (e) {
    hotkeyState = { ok: false, registered: false, accelerator: acc, error: e.message };
    if (core) core.logger.warn('app', `全局快捷键 ${acc} 注册异常：${e.message}`);
  }
  return hotkeyState;
}

function applyShellLanguage() {
  if (win && !win.isDestroyed()) win.setTitle(TT('WFM 价格监控', 'WFM Market Monitor'));
  if (tray) tray.setToolTip(TT('WFM 价格监控', 'WFM Market Monitor'));
}

function broadcast(type, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('push', { type, payload });
  }
}

function showDesktopNotification({ title, body, urgency, targetId }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title,
    body,
    urgency: urgency || 'normal',
    icon: iconPath() || undefined,
    silent: false,
    timeoutType: 'default',
  });
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('push', { type: 'focus-target', payload: { targetId } });
    }
  });
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0b0f14',
    title: 'WFM 价格监控',
    autoHideMenuBar: true,
    icon: iconPath() || undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '../web/index.html'));

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) {
      // eslint-disable-next-line no-console
      console.log(`[renderer:${level}] ${message}`);
    }
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    // eslint-disable-next-line no-console
    console.error('preload error', preloadPath, err);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // eslint-disable-next-line no-console
    console.error('did-fail-load', code, desc);
  });

  win.once('ready-to-show', () => {
    win.show();
    if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
    const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
    if (shotArg) {
      const out = shotArg.split('=')[1];
      const waitArg = process.argv.find((a) => a.startsWith('--screenshot-wait='));
      const waitMs = waitArg ? Number(waitArg.split('=')[1]) || 6000 : 6000;
      setTimeout(async () => {
        try {
          const evalArg = process.argv.find((a) => a.startsWith('--screenshot-eval='));
          const evalFileArg = process.argv.find((a) => a.startsWith('--screenshot-eval-file='));
          if (evalFileArg) {
            const r = await win.webContents.executeJavaScript(fs.readFileSync(evalFileArg.split('=')[1], 'utf8'));
            console.log('EVAL RESULT:', JSON.stringify(r));
            await new Promise((r) => setTimeout(r, 1800));
          } else if (evalArg) {
            await win.webContents.executeJavaScript(decodeURIComponent(evalArg.slice('--screenshot-eval='.length)));
            await new Promise((r) => setTimeout(r, 1800));
          }
          win.show();
          win.focus();
          win.webContents.setBackgroundThrottling(false);
          win.webContents.invalidate();
          await new Promise((r) => setTimeout(r, 400));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          // eslint-disable-next-line no-console
          console.log(`screenshot saved: ${out}`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('screenshot failed', e);
        }
        quitting = true;
        app.quit();
      }, waitMs);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  const p = iconPath();
  if (!p) return;
  try {
    const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('WFM 价格监控');
    const rebuild = () => {
      const paused = core ? core.config.get().global.paused : false;
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: TT('显示主界面', 'Show window'), click: () => { if (win) { win.show(); win.focus(); } } },
          {
            label: paused ? TT('恢复监控', 'Resume monitoring') : TT('暂停监控', 'Pause monitoring'),
            click: () => {
              if (!core) return;
              core.saveSettings({ global: { paused: !paused } });
              broadcast('settings-changed', core.settings());
              rebuild();
            },
          },
          { type: 'separator' },
          { label: TT('立即检查全部', 'Check all now'), click: () => { if (core) core.checkAll(); } },
          { type: 'separator' },
          { label: TT('退出', 'Quit'), click: () => { quitting = true; app.quit(); } },
        ])
      );
    };
    rebuild();
    tray._rebuild = rebuild;
    tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  } catch (_) {
    tray = null;
  }
}

// ---------------- IPC ----------------
function registerIpc() {
  const handlers = {
    'app:status': () => core.status(),
    'app:diagnose': () => core.diagnose(),
    'app:settings': () => core.settings(),
    'app:defaults': () => core.getDefaults(),
    'app:reset-settings': () => {
      const d = core.resetSettings();
      applyShellLanguage();
      if (tray && tray._rebuild) tray._rebuild();
      broadcast('hotkey-state', applyHotkey());
      broadcast('settings-changed', d);
      return d;
    },
    'app:save-settings': (_e, patch) => {
      const next = core.saveSettings(patch);
      applyShellLanguage();
      if (tray && tray._rebuild) tray._rebuild();
      broadcast('hotkey-state', applyHotkey());
      broadcast('settings-changed', next);
      return next;
    },
    'control:status': () => core.control.status(),
    'control:poll': () => core.control.pollOnce(),
    'app:test-notify': () => core.testNotify(),
    'app:refresh-catalog': () => core.refreshCatalog(),
    'app:open-external': (_e, url) => shell.openExternal(url),
    'app:hotkey-status': () => hotkeyState,
    // 走一遍「主进程 -> 渲染层 -> 全部检查」的完整链路（设置页「测试」按钮用，也可用于排查系统级热键被占用）
    'app:hotkey-test': () => { broadcast('hotkey-fired', { accelerator: hotkeyState.accelerator || 'manual' }); return hotkeyState; },
    'app:copy-text': (_e, text) => { clipboard.writeText(String(text == null ? '' : text)); return true; },
    'app:version': () => ({ app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }),
    'app:log': (_e, n) => core.logger.tail(n || 200),

    'targets:list': () => core.targets(),
    'targets:add': (_e, input) => core.addTarget(input),
    'targets:update': (_e, id, patch) => core.updateTarget(id, patch),
    'targets:remove': (_e, id) => core.removeTarget(id),
    'targets:check-now': (_e, id) => core.checkNow(id),
    'targets:check-all': () => core.checkAll(),

    'search:items': (_e, q) => core.searchItems(q),
    'search:weapons': (_e, q) => core.searchWeapons(q),
    'search:attrs': () => core.listAttrs(),
    'items:detail': (_e, slug) => core.itemDetail(slug),

    'events:list': (_e, n) => core.events(n),
    'events:clear': () => core.clearEvents(),

    'stats:item': (_e, slug) => core.marketSource.fetchStats(slug),
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        const data = await fn(e, ...args);
        return { ok: true, data };
      } catch (err) {
        return {
          ok: false,
          error: {
            message: err.message,
            code: err.code || null,
            candidateCount: err.candidates ? err.candidates.length : 0,
            kind: err.kind || null,
            advice: err.advice || null,
          },
        };
      }
    });
  }
}

async function boot() {
  core = new App({ dataDir: dataDir(), hooks: { showDesktop: showDesktopNotification } });
  core.on('target-update', (v) => broadcast('target-update', v));
  core.on('trigger', (ev) => broadcast('trigger', ev));
  core.on('target-removed', (p) => broadcast('target-removed', p));
  core.on('stream-state', (s) => broadcast('stream-state', s));
  core.on('log', (rec) => {
    if (rec.level === 'error' || rec.level === 'warn') broadcast('log', rec);
  });
  core.on('monitor-error', (e) => broadcast('monitor-error', e));

  await core.init();
  registerIpc();
  createWindow();
  createTray();
  applyShellLanguage();
  applyHotkey();
}

app.whenReady().then(boot);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) win.show();
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
});

app.on('before-quit', async (e) => {
  quitting = true;
  if (core) {
    e.preventDefault();
    try {
      await core.shutdown();
    } catch (_) {}
    core = null;
    setTimeout(() => app.exit(0), 200);
  }
});

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaught', err);
  try {
    dialog.showErrorBox(TT('发生未捕获错误', 'Unexpected error'), String(err && err.stack ? err.stack : err));
  } catch (_) {}
});
