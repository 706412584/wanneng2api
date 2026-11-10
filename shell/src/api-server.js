'use strict';
/**
 * api-server.js — Manager API（DESIGN.md §4.4）
 *
 * Node http 模块内嵌主进程，仅绑定 127.0.0.1。
 * CORS 仅允许 file:// 与 127.0.0.1 来源。
 */

const http = require('http');
const { URL } = require('url');

const MAX_BODY = 1024 * 1024;

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / 同源
  if (origin === 'null') return true; // file:// 页面 fetch 的 Origin 是 "null"
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch (_e) {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(origin),
  });
  res.end(body);
}

class ApiServer {
  /**
   * @param {object} deps
   * @param {import('./platform-manager').PlatformManager} deps.manager
   * @param {import('./updater').PlatformUpdater} deps.updater
   * @param {import('./config').ConfigStore} deps.store
   * @param {Function} deps.openExternal (url) => void  — Electron shell.openExternal 注入
   * @param {Function} [deps.getHubStatus]  () => Promise<object>
   * @param {Function} [deps.reloadHub]     () => Promise<object>
   * @param {object} [opts] { listen }
   */
  constructor(deps, opts = {}) {
    this.deps = deps;
    this.opts = opts;
    this.server = null;
  }

  listen(listenAddr = '127.0.0.1:17800') {
    const [host, port] = listenAddr.split(':');
    this.server = http.createServer((req, res) => this._handler(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(Number(port), host || '127.0.0.1', () => resolve(this.server.address()));
    });
  }

  close() {
    if (this.server) return new Promise((r) => this.server.close(r));
    return Promise.resolve();
  }

  async _handler(req, res) {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      return json(res, 403, { error: 'origin not allowed' }, null);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }

    const u = new URL(req.url, `http://127.0.0.1`);
    const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]

    try {
      // SSE 日志流（无 body）
      const mStream = u.pathname.match(/^\/api\/platforms\/([^/]+)\/logs\/stream$/);
      if (mStream && req.method === 'GET') return this._sseLogs(req, res, decodeURIComponent(mStream[1]), origin);

      // 读 body
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await this._readBody(req);
      }

      const r = await this._route(req.method, parts, body, u, origin);
      if (r === undefined) return json(res, 404, { error: `not found: ${req.method} ${u.pathname}` }, origin);
      return json(res, r.__code || 200, r, origin);
    } catch (e) {
      const code = /未知平台|未配置|不存在|未找到/.test(e.message) ? 404 : 400;
      return json(res, code, { error: e.message }, origin);
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_e) { resolve({}); }
      });
      req.on('error', reject);
    });
  }

  async _route(method, parts, body, u, origin) {
    const { manager, updater, store } = this.deps;
    // 非 /api 前缀
    if (parts[0] !== 'api') return undefined;

    // GET /api/overview
    if (method === 'GET' && parts[1] === 'overview' && parts.length === 2) {
      const platforms = manager.statusList();
      return {
        ts: Date.now(),
        running: platforms.filter((p) => ['healthy', 'starting', 'degraded', 'unhealthy'].includes(p.status)).length,
        total: platforms.length,
        alerts: platforms.filter((p) => p.status === 'unhealthy' || p.status === 'error').length,
        platforms,
        hub: manager.statusOf('hub'),
      };
    }

    // GET /api/platforms
    if (method === 'GET' && parts[1] === 'platforms' && parts.length === 2) {
      return { platforms: manager.statusList() };
    }

    // /api/platforms/:id/...
    if (parts[1] === 'platforms' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      const rest = parts.slice(3);

      if (!rest.length) {
        if (method === 'GET') return manager.statusOf(id) || { error: `未知平台: ${id}` };
        return undefined;
      }
      const [action] = rest;

      if (method === 'POST') {
        if (action === 'start') return manager.start(id);
        if (action === 'stop') return manager.stop(id);
        if (action === 'restart') return manager.restart(id);
        if (action === 'enable') return manager.enable(id);
        if (action === 'disable') return manager.disable(id);
        if (action === 'open-panel') {
          const p = store.getPlatform(id);
          if (!p) throw new Error(`未知平台: ${id}`);
          const url = p.adminPanel || `http://127.0.0.1:${p.port}/`;
          if (this.deps.openExternal) this.deps.openExternal(url);
          else if (process.platform === 'win32') {
            // 测试环境无 Electron：start 命令兜底
            require('child_process').exec(`start "" "${url}"`, { windowsHide: true }, () => {});
          }
          return { id, opened: url };
        }
        if (action === 'update') {
          if (rest[1] === 'check') return updater.check(id);
          if (rest[1] === 'apply') return updater.apply(id, body && body.checkInfo);
        }
      }

      if (method === 'GET') {
        if (action === 'detail') return this._platformDetail(id);
        if (action === 'logs') {
          const tail = Math.min(500, Math.max(1, Number(u.searchParams.get('tail')) || 200));
          return { id, lines: manager.tailLogs(id, tail) };
        }
      }
      return undefined;
    }

    // GET /api/hub/status
    if (method === 'GET' && parts[1] === 'hub' && parts[2] === 'status') {
      if (this.deps.getHubStatus) return this.deps.getHubStatus();
      const rt = manager.statusOf('hub');
      return { status: rt ? rt.status : 'unknown', detail: rt };
    }

    // POST /api/hub/reload
    if (method === 'POST' && parts[1] === 'hub' && parts[2] === 'reload') {
      if (this.deps.reloadHub) return this.deps.reloadHub();
      // 兜底：重启 hub 平台（等效热重载配置）
      const rt = manager.getRuntime('hub');
      if (!rt) throw new Error('未找到 hub 平台');
      return manager.restart('hub');
    }

    // GET/PUT /api/settings
    if (parts[1] === 'settings' && parts.length === 2) {
      if (method === 'GET') return store.manager;
      if (method === 'PUT') {
        const cur = store.manager;
        // 浅合并一级，避免整对象覆盖丢失默认键
        const merged = { ...cur };
        for (const k of Object.keys(body)) {
          if (typeof body[k] === 'object' && body[k] !== null && !Array.isArray(body[k])
            && typeof cur[k] === 'object' && cur[k] !== null) {
            merged[k] = { ...cur[k], ...body[k] };
          } else {
            merged[k] = body[k];
          }
        }
        store.manager = merged;
        store.saveManager();
        return store.manager;
      }
    }

    // GET /api/updates/summary
    if (method === 'GET' && parts[1] === 'updates' && parts[2] === 'summary') {
      return { updates: await updater.summary() };
    }

    return undefined;
  }

  _platformDetail(id) {
    const { manager, store } = this.deps;
    const p = store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    const snap = manager.statusOf(id) || {};
    return {
      ...snap,
      config: {
        type: p.type,
        mode: p.mode,
        workDir: p.workDir,
        run: p.run,
        port: p.port,
        health: p.health,
        adminPanel: p.adminPanel,
        updater: p.updater ? { ...p.updater, githubToken: undefined } : null,
        restart: p.restart,
        requires: p.requires,
      },
      restartAttempts: snap.restartAttempts || 0,
      lastError: snap.lastError || '',
    };
  }

  _sseLogs(req, res, id, origin) {
    const rt = this.deps.manager.getRuntime(id);
    if (!rt) return json(res, 404, { error: `未知平台: ${id}` }, origin);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders(origin),
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ id, size: rt.ring.size })}\n\n`);
    // 先推最近 200 行
    for (const line of rt.ring.tail(200)) {
      res.write(`event: log\ndata: ${JSON.stringify({ id, line })}\n\n`);
    }
    const off = this.deps.manager.onLog(id, (pid, _stream, line) => {
      if (res.writableEnded) return;
      res.write(`event: log\ndata: ${JSON.stringify({ id: pid, line })}\n\n`);
    });
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(`: ping\n\n`);
    }, 15000);
    req.on('close', () => {
      off();
      clearInterval(ping);
      res.end();
    });
  }
}

module.exports = { ApiServer, isAllowedOrigin };
