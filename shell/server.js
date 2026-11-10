#!/usr/bin/env node
// 纯前端管理台：不依赖 Electron，直接跑 Manager API + 静态托管 ui/dist。
//
//   node server.js                    # 管理台 http://127.0.0.1:17800
//   node server.js --port 17801       # 改端口
//   node server.js --no-autostart     # 只提供管理界面，不自动拉起平台
//
// 与 Electron 壳共用同一套 PlatformManager / ApiServer / ConfigStore，
// 区别只在于：这里没有窗口、托盘、自动更新，一切通过浏览器操作。

const http = require('http');
const fs = require('fs');
const path = require('path');

const { ConfigStore } = require('./src/config');
const { PlatformManager } = require('./src/platform-manager');
const { PlatformUpdater } = require('./src/updater');
const { ApiServer } = require('./src/api-server');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const PORT = Number(argOf('--port', '17800'));
const HOST = argOf('--host', '127.0.0.1');
const AUTO_START = !has('--no-autostart');

const UI_DIR = path.resolve(__dirname, '..', 'ui', 'dist');

const log = {
  info: (m) => console.log(`${new Date().toISOString()} [info] ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} [warn] ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} [error] ${m}`),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  // SPA 路由：非资源路径一律回 index.html
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(UI_DIR, rel);

  // 目录穿越防护：解析后的路径必须仍在 UI_DIR 内
  if (!path.resolve(file).startsWith(path.resolve(UI_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf);
  });
}

async function main() {
  if (!fs.existsSync(path.join(UI_DIR, 'index.html'))) {
    log.error(`UI 构建产物不存在：${UI_DIR}/index.html`);
    log.error('请先执行：cd ui && npm install && npm run build');
    process.exit(1);
  }

  const store = new ConfigStore();
  const manager = new PlatformManager({ store, dataDir: store.dataDir, logger: log });
  const updater = new PlatformUpdater({ store, manager, logger: log });

  const api = new ApiServer({
    manager,
    updater,
    store,
    openExternal: (url) => {
      // 无 Electron：交给系统默认浏览器打开
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
      require('child_process').exec(cmd, { windowsHide: true }, () => {});
    },
  });
  await api.listen(`${HOST}:${PORT}`);

  // 同一个端口托管 UI：/api/* 走 Manager API，其余走静态文件。
  // ApiServer 已经监听在该端口上，静态资源由它的 404 分支兜底会更简单，
  // 所以这里改为在 ApiServer 之外再起一个静态服务会端口冲突——改用
  // ApiServer 的 staticDir 选项（见下）。
  if (typeof api.serveStatic === 'function') api.serveStatic(UI_DIR);
  else log.warn('ApiServer 未提供静态托管，管理台需单独托管 ui/dist');

  log.info(`管理台已启动：http://${HOST}:${PORT}`);
  log.info(`数据目录：${store.dataDir}`);
  log.info(`平台：${store.platforms.platforms.map((p) => `${p.id}:${p.port}`).join('  ')}`);

  if (AUTO_START) {
    log.info('自动启动已启用平台…');
    await manager.startAutoStart();
  } else {
    log.info('已跳过自动启动（--no-autostart）');
  }

  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在停止全部平台…`);
    await manager.stopAll().catch(() => {});
    await api.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log.error(`启动失败：${e.stack || e.message}`);
  process.exit(1);
});