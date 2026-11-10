'use strict';
/**
 * main.js — Electron 主进程入口（DESIGN.md §4.6 壳子生命周期）
 *
 * 启动 → single-instance lock → 读配置 → Splash 等健康 → 主窗口 → 托盘
 * UI 未就绪时使用内置占位页；../ui/dist/index.html 存在则 loadFile。
 * Electron 相关（窗口/托盘/自启）只在本文件引用，其余模块均为纯 Node。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { ConfigStore } = require('./config');
const { PlatformManager } = require('./platform-manager');
const { PlatformUpdater } = require('./updater');
const { ApiServer } = require('./api-server');
const { createTray, rebuildTrayMenu, destroyTray } = require('./tray');

// ── 全局状态 ──
let store = null;
let manager = null;
let updater = null;
let api = null;
let mainWindow = null;
let splashWindow = null;
let tray = null;
let quitting = false;
let closeAction = 'tray';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

// ── 壳自身日志 ──
let managerLogWriter = null;
function shellLog(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  if (managerLogWriter) managerLogWriter.write(line);
}

// ── UI 路径：../ui/dist/index.html 存在则用之，否则占位页 ──
function uiIndexHtml() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'ui', 'dist', 'index.html'),
    path.join(process.resourcesPath || '', 'ui', 'index.html'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { file: c, placeholder: false };
  }
  return { placeholder: true };
}

function placeholderHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Wanneng2API</title>
<style>
 body{font-family:"Segoe UI",sans-serif;background:#111723;color:#e8eefc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
 .card{max-width:640px;padding:40px;border:1px solid #2a3550;border-radius:12px;background:#161f33}
 h1{font-size:20px;margin:0 0 12px}p{color:#8fa1c0;line-height:1.7;margin:6px 0}
 code{background:#0d1420;padding:2px 6px;border-radius:4px;color:#7fb2ff}
</style></head>
<body><div class="card">
<h1>Wanneng2API 壳已启动</h1>
<p>UI 构建产物待接入：把 React UI 构建输出放到 <code>ui/dist/index.html</code>，重启壳即自动加载。</p>
<p>Manager API 已在本机监听：<code>http://127.0.0.1:17800</code></p>
<p>可用端点：<code>GET /api/overview</code>、<code>GET /api/platforms</code>、<code>POST /api/platforms/:id/start|stop|restart</code> 等，详见 shell/selftest.md。</p>
</div></body></html>`;
}

function createMainWindow() {
  const ui = uiIndexHtml();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Wanneng2API',
    show: false,
    backgroundColor: '#111723',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  if (ui.placeholder) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(placeholderHtml()));
  } else {
    mainWindow.loadFile(ui.file);
  }
  mainWindow.once('ready-to-show', () => {
    if (!store.manager.general.startMinimized || !tray) mainWindow.show();
  });
  mainWindow.on('close', (e) => {
    // closeAction=tray：窗口隐藏，进程保留
    if (!quitting && closeAction === 'tray') {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 200,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: { contextIsolation: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:"Segoe UI",sans-serif;background:rgba(17,23,35,.96);color:#f3f7ff;
      display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
    h1{font-size:17px;font-weight:600;margin:0 0 8px}p{font-size:12px;color:#6c7a92;margin:0 0 14px}
    .bar{width:220px;height:4px;background:rgba(127,178,255,.15);border-radius:2px;overflow:hidden}
    .in{height:100%;background:linear-gradient(90deg,#7fb2ff,#8de3ff);width:0%;transition:width .3s}
  </style></head><body>
    <h1>Wanneng2API</h1><p id="msg">正在启动平台...</p>
    <div class="bar"><div class="in" id="p"></div></div>
  </body></html>`;
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function splashProgress(cur, total) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const pct = Math.min(Math.round((cur / total) * 100), 99);
  splashWindow.webContents.executeJavaScript(
    `document.getElementById('p').style.width='${pct}%';` +
    `document.getElementById('msg').textContent='等待平台健康... (${cur}s)';`
  ).catch(() => {});
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
}

/** 参考 AAR waitForBackend：等待任一平台健康/或总超时，期间推进度条 */
function waitForPlatforms(sec = 60) {
  return new Promise((resolve) => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      splashProgress(n, sec);
      const list = manager.statusList().filter((s) => s.enabled !== false);
      const anyUp = list.some((s) => ['healthy', 'starting'].includes(s.status));
      const settled = list.every((s) => ['healthy', 'stopped', 'error', 'unhealthy'].includes(s.status));
      if (anyUp || settled || n >= sec) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

function applyAutoStart() {
  const want = !!(store.manager.general && store.manager.general.autoStart);
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      path: process.execPath,
      args: ['--hidden'],
    });
  } catch (e) {
    shellLog('warn', `setLoginItemSettings 失败: ${e.message}`);
  }
}

// ── electron-updater（壳自身更新，§7.4）──
function setupSelfUpdater() {
  if (process.platform !== 'win32' || app.isPackaged !== true) return; // 开发环境跳过
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '发现新版本',
        message: `壳新版本 v${info.version} 可用，是否下载？`,
        buttons: ['下载更新', '稍后'], defaultId: 0,
      }).then(({ response }) => { if (response === 0) autoUpdater.downloadUpdate(); });
    });
    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '更新就绪',
        message: '壳更新已下载，重启应用即可安装。',
        buttons: ['立即重启', '稍后'], defaultId: 0,
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.on('error', (err) => shellLog('warn', `[self-update] ${err.message}`));
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10000);
  } catch (e) {
    shellLog('warn', `electron-updater 初始化失败: ${e.message}`);
  }
}

// ── 启动流程 ──
app.whenReady().then(async () => {
  // 1. 读配置（数据目录 %AppData%/wanneng2api）
  const dataDir = path.join(app.getPath('appData'), 'wanneng2api');
  store = new ConfigStore(dataDir);
  closeAction = (store.manager.general && store.manager.general.closeAction) || 'tray';

  managerLogWriter = new (require('./logs').RotatingFileWriter)(
    path.join(dataDir, 'logs', 'manager.log'), { rotateBytes: 10 * 1024 * 1024, keepFiles: 5 });
  const logger = {
    info: (m) => shellLog('info', m),
    warn: (m) => shellLog('warn', m),
    error: (m) => shellLog('error', m),
  };

  // 2. PlatformManager + Updater + Manager API
  manager = new PlatformManager({ store, dataDir, shellRoot: path.resolve(__dirname, '..'), logger });
  updater = new PlatformUpdater({ manager, store, dataDir, logger });
  api = new ApiServer({ manager, updater, store, openExternal: (u) => shell.openExternal(u) });
  const listen = (store.manager.manager && store.manager.manager.listen) || '127.0.0.1:17800';
  try {
    const addr = await api.listen(listen);
    logger.info(`Manager API listening on ${addr.address}:${addr.port}`);
  } catch (e) {
    dialog.showErrorBox('端口冲突', `Manager API ${listen} 启动失败: ${e.message}`);
    app.quit();
    return;
  }

  // 状态变化时刷新托盘菜单
  manager.on('status', () => rebuildTrayMenu({ manager, store, showMainWindow, appQuit: () => app.quit(), trayRef: tray }));

  // 3. Splash → 按需 spawn autoStartPlatforms → 等健康 → 主窗口 → 托盘
  createSplash();
  createMainWindow(); // 先建好（ready-to-show 后才显示）
  try {
    await manager.startAutoStart();
  } catch (e) {
    logger.error(`自启编排失败: ${e.message}`);
  }
  await waitForPlatforms(60);
  closeSplash();
  showMainWindow();

  // 4. 托盘
  tray = createTray({ manager, store, showMainWindow, appQuit: () => app.quit() });
  rebuildTrayMenu({ manager, store, showMainWindow, appQuit: () => app.quit(), trayRef: tray });

  // 5. 开机自启 + 壳自更新
  applyAutoStart();
  setupSelfUpdater();
});

// ── 退出：反序 stop 平台 → flush 日志 → quit ──
async function gracefulQuit() {
  if (quitting) return;
  quitting = true;
  try { if (manager) await manager.stopAll(); } catch (_e) { /* ignore */ }
  try { if (api) await api.close(); } catch (_e) { /* ignore */ }
  destroyTray();
  app.quit();
}

app.on('before-quit', (e) => {
  if (!quitting && manager && manager.statusList().some((s) => s.pid)) {
    e.preventDefault();
    gracefulQuit();
  }
});

app.on('window-all-closed', () => {
  // closeAction=tray：不退出（窗口只是隐藏）；closeAction=quit：退出
  if (closeAction === 'quit') gracefulQuit();
});

app.on('activate', () => showMainWindow());

process.on('uncaughtException', (err) => {
  shellLog('error', `uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  shellLog('error', `unhandledRejection: ${reason}`);
});
