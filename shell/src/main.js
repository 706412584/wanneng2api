'use strict';
/**
 * main.js — Electron 主进程入口（DESIGN.md §4.6 壳子生命周期）
 *
 * 启动 → single-instance lock → 读配置 → Splash 等健康 → 主窗口 → 托盘
 * UI 未就绪时使用内置占位页；../ui/dist/index.html 存在则 loadFile。
 * Electron 相关（窗口/托盘/自启）只在本文件引用，其余模块均为纯 Node。
 */

const { app, BrowserWindow, dialog, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { ConfigStore } = require('./config');
const { PlatformManager } = require('./platform-manager');
const { PlatformUpdater } = require('./updater');
const { ApiServer } = require('./api-server');
const { createTray, rebuildTrayMenu, destroyTray } = require('./tray');
const proxy = require('./proxy');

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
// 壳内无痕登录窗（限制并发，关闭即销毁内存会话）
const loginWindows = new Set();

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
    // 打包后：extraResources 把 ui/dist 整个拷到 resources/ui
    path.join(process.resourcesPath || '', 'ui', 'index.html'),
    // 开发时：仓库里的 ui/dist
    path.resolve(__dirname, '..', '..', 'ui', 'dist', 'index.html'),
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

/**
 * 优先用 Manager API 的 http 地址加载 UI（同源，iframe cookie 才生效）。
 * 服务还没起来时轮询最多 15s，仍失败则回退 file://，保证界面可见。
 */
function loadUiFromManager(port, fileFallback) {
  const url = `http://127.0.0.1:${port}/`;
  let tries = 0;
  const attempt = () => {
    tries += 1;
    const probe = require('http').get(url, { timeout: 1500 }, (res) => {
      res.resume();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
    });
    probe.on('error', () => {
      if (tries >= 15) {
        shellLog('warn', 'Manager API 未就绪，回退 file:// 加载 UI');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(fileFallback);
        return;
      }
      setTimeout(attempt, 1000);
    });
    probe.on('timeout', () => { probe.destroy(); });
  };
  attempt();
}

/** 自绘标题栏用的窗口控制 IPC（frame:false 下系统按钮不存在） */
function setupWindowControls() {
  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => {
    // 走 close()，让 closeAction=tray 的隐藏逻辑照常生效
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('window:is-maximized', () =>
    !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));
  // 只接受来自本应用页面（http://127.0.0.1:17800 或 file:// 回退页）的调用：
// 外部页面若能拿到 bridge，就不能借它开窗/打开系统浏览器。
  ipcMain.handle('login:open', (e, { url, mode } = {}) => {
    const from = e?.senderFrame?.url || '';
    const okSource = /^http:\/\/127\.0\.0\.1:(17800|5173)\//.test(from) || /^file:\/\//.test(from);
    if (!okSource) return { ok: false, error: '来源不允许' };
    return openLoginPage(url, mode);
  });
}

/**
 * 登录页的两种打开方式：
 *   system    → 系统默认浏览器（与旧行为一致）
 *   incognito → 壳内独立窗口，使用一次性 session 分区：
 *               partition 不带 persist: 前缀 = 内存会话，不写 cookie/缓存到磁盘，
 *               窗口关闭后该会话即销毁。授权页仍在同一应用内，回调可直接回传。
 *
 * 只接受 http(s)，拒绝 file: / javascript: 等协议，避免被前端传入的串利用。
 */
function openLoginPage(url, mode) {
  let target;
  try { target = new URL(String(url || '')); } catch { return { ok: false, error: '授权链接无效' }; }
  if (!['https:', 'http:'].includes(target.protocol)) return { ok: false, error: '只允许 http(s) 授权链接' };
  if (mode !== 'incognito') {
    shell.openExternal(target.href);
    return { ok: true, mode: 'system' };
  }
  // 限制并发登录窗：避免被反复调用开无限窗口
  if (loginWindows.size >= 3) return { ok: false, error: '已有多个登录窗口，请先关闭' };
  try {
    const { session } = require('electron');
    const part = 'login-incognito-' + Date.now();
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      title: '登录（无痕）',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        // 无 persist: 前缀 → 内存会话，落盘为 0
        partition: part,
        nodeIntegration: false,
        contextIsolation: true,
        // 授权页不需要任何 preload 能力
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    loginWindows.add(win);
    win.webContents.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/i.test(next)) shell.openExternal(next);
      return { action: 'deny' };
    });
    // 只允许 http(s) 导航：file:/javascript: 等一律取消
    win.webContents.on('will-navigate', (ev, next) => {
      if (!/^https?:/i.test(String(next || ''))) ev.preventDefault();
    });
    // 关闭窗口即销毁该内存会话，确保没有残留 cookie
    win.on('closed', () => {
      loginWindows.delete(win);
      try { session.fromPartition(part).clearStorageData(); } catch { /* 已销毁 */ }
    });
    win.loadURL(target.href).catch(() => {});
    return { ok: true, mode: 'incognito' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    // Windows 下 titleBarStyle:'hidden' 会把最小化/最大化/关闭一起拿掉，
    // 所以改用 frame:false + 前端自绘按钮（参考 any-auto-register）：
    // preload 暴露 window:minimize|maximize|close，UI 顶部画一条可拖拽的标题栏。
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // 彻底移除菜单（autoHideMenuBar 只是隐藏，按 Alt 还会冒出来）
  Menu.setApplicationMenu(null);

  // 用 http:// 加载 UI，而不是 file://。
  // 原因：内嵌 magpie 控制台（iframe 指向 http://127.0.0.1:17899）需要 cookie；
  // 页面从 file:// 发起请求属于跨站，SameSite=Lax 的 cookie 会被丢弃，
  // 每次都落回 magpie 的登录页。走同源 http 就没有这个问题。
  const apiPort = (store.manager.manager && store.manager.manager.listen || '127.0.0.1:17800').split(':').pop();
  if (ui.placeholder) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(placeholderHtml()));
  } else {
    // ApiServer 尚未 listen 时先等它；失败则回退 file://（至少界面能显示）
    loadUiFromManager(apiPort, ui.file);
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
  // 最大化状态变化 → 通知前端切换按钮图标
  const pushMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', pushMaxState);
  mainWindow.on('unmaximize', pushMaxState);
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

/**
 * 参考 AAR waitForBackend：等平台起来，期间推进度条。
 *
 * 注意不能把 starting 当成"已就绪"：平台可能长时间停在 starting（例如网关
 * 起来了但健康检查一直不过），那样 anyUp 会永远为真，Splash 就再也关不掉。
 * 所以判据只认"有平台真到过 healthy"，或"全部都有结论"，再加硬超时兜底。
 */
function waitForPlatforms(sec = 45) {
  return new Promise((resolve) => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      splashProgress(n, sec);
      const list = manager.statusList().filter((s) => s.enabled !== false);
      const anyHealthy = list.some((s) => s.status === 'healthy');
      const settled = list.every((s) => !['starting', 'updating'].includes(s.status));
      if (anyHealthy || settled || n >= sec) {
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
  // Linux 走 AppImage 自更新；deb/rpm 装出来的包没有可替换的镜像文件，
  // electron-updater 会直接报错，所以只对 AppImage 启用。
  if (app.isPackaged !== true) return; // 开发环境跳过
  if (process.platform === 'darwin') return; // 未签名，macOS 自更新不可用
  if (process.platform !== 'win32' && !process.env.APPIMAGE) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // 壳自更新的代理：electron-updater 走自己的下载器，不认我们给 http/https
    // 装的 agent，必须显式告诉它。勾选「壳自更新」且地址合法才设。
    applyProxyToUpdater();
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

/**
 * 把代理解析结果写入壳自更新。禁用或地址不合法时清空，避免关掉代理后
 * electron-updater 还沿用旧代理。设置保存后会再次调用。
 */
function applyProxyToUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    const p = proxy.config();
    const usable = p.enabled && p.scopes.selfUpdate && proxy.validProxyUrl(p.url);
    // electron-updater 的 setProxy 收 null 表示不用代理
    autoUpdater.setProxy(usable ? p.url : null);
  } catch (e) {
    shellLog('warn', `[self-update] 设置代理失败: ${e.message}`);
  }
}

// ── 启动流程 ──
app.whenReady().then(async () => {
  // 1. 读配置（数据目录 %AppData%/wanneng2api）
  const dataDir = path.join(app.getPath('appData'), 'wanneng2api');
  store = new ConfigStore(dataDir);
  proxy.init(store);
  proxy.setLogger((m) => shellLog('info', m));
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
  api = new ApiServer({
    manager, updater, store,
    openExternal: (u) => shell.openExternal(u),
    // 设置保存后（代理可能变了）：壳自更新要重新下发代理
    onSettingsSaved: () => applyProxyToUpdater(),
  });
  // 同一个端口托管 UI：主窗口走 http://127.0.0.1:17800/ 而不是 file://
  // （见 loadUiFromManager 的说明），所以这里必须把静态目录挂上。
  const uiInfo = uiIndexHtml();
  if (!uiInfo.placeholder && uiInfo.file) {
    api.serveStatic(path.dirname(uiInfo.file));
  }
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
  setupWindowControls();   // frame:false 的自绘标题栏需要这些 IPC
  createMainWindow(); // 先建好（ready-to-show 后才显示）
  // 自启不阻塞启动流程：start() 内部会等平台健康（最长 120s），
  // 若有平台起不来，整个界面会一起卡在 Splash 上。让它在后台跑，
  // Splash 只等"有平台健康"或总超时。
  manager.startAutoStart().catch((e) => logger.error(`自启编排失败: ${e.message}`));
  await waitForPlatforms(45);
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
