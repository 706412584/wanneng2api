'use strict';
/**
 * api-server.js — Manager API（DESIGN.md §4.4）
 *
 * Node http 模块内嵌主进程，仅绑定 127.0.0.1。
 * CORS 仅允许 file:// 与 127.0.0.1 来源。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const pathExtname = (p) => path.extname(p);
const { findMagpieBinary } = require('./platform-manager');

const MAX_BODY = 1024 * 1024;

/**
 * 来源判定。
 *
 * 写操作（POST/PUT）额外要求「不可被跨站伪造」的来源：
 *  - Origin 缺失：非浏览器客户端（curl / 桌面主进程 fetch）→ 放行。
 *  - Origin=null：**不**能无条件放行。它同时来自两种完全不同的东西：
 *      1) 壳回退到 file:// 加载的 UI（可信，同为用户本机自己的页面）
 *      2) 任意网页里的 sandbox iframe 或 no-referrer 表单提交（不可信）
 *    浏览器在跨站写请求里会带 Origin，所以这里再要求自定义头
 *    `X-Wanneng-Client`：跨站简单请求无法设置它（会触发预检且被 CORS 拒绝），
 *    而壳自己的 UI 会带（见 api/client.js）。这样既保住 file:// 回退，
 *    又堵住 CSRF 杀进程。
 *  - 127.0.0.1/localhost：放行（本机页面）。
 */
const CLIENT_HEADER = 'x-wanneng-client';

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / 同源 / 桌面主进程
  if (origin === 'null') return true; // 具体写操作再由 _isTrustedWrite 二次校验
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch (_e) {
    return false;
  }
}

/** 写操作来源校验：Origin=null 时必须带壳自己的自定义头 */
function isTrustedWrite(origin, headers) {
  if (origin !== 'null') return true;
  return String((headers && headers[CLIENT_HEADER]) || '') === 'wanneng2api';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Wanneng-Client',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 把代理范围里属于 magpie 的两项（订阅流量 / 插件流量）写进它的设置。
 *
 * 用 magpie 自己的 CLI 而不是它的 Web API：CLI 是官方稳定接口，`settings set`
 * 带取值校验，且不需要处理控制台会话 cookie。magpie 不在（未安装/未运行）时
 * 直接跳过——代理设置对壳其余部分依然有效，不该因此报错。
 */
function syncMagpieProxy(store) {
  const proxy = require('./proxy');
  const want = proxy.magpieEnv();          // { proxy, pluginProxy }
  const bin = findMagpieBinary(store && store.dataDir);
  if (!bin) return { skipped: '未找到 magpie 可执行文件' };

  const { execFile } = require('child_process');
  const applied = {};
  const pending = Object.entries(want).map(([key, value]) => new Promise((resolve) => {
    // 只写「与当前值不同」的项，避免每次保存设置都无谓地重启 magpie 的配置
    execFile(bin, ['settings', 'get', key], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const current = String(stdout || '').trim().replace(/^"|"$/g, '');
      if (!err && current === value) { applied[key] = 'unchanged'; return resolve(); }
      execFile(bin, ['settings', 'set', key, value], { windowsHide: true, timeout: 20000 }, (e2) => {
        applied[key] = e2 ? `失败: ${e2.message}` : 'ok';
        resolve();
      });
    });
  }));
  return Promise.all(pending).then(() => applied);
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
    this.pluginPanel = deps.pluginPanel || new (require('./magpie-adapter').PluginPanel)({
      getConfig: () => deps.store.getPlatform('magpie-web'),
    });
    this.routingGroups = deps.routingGroups || new (require('./magpie-adapter').RoutingGroups)({
      getConfig: () => deps.store.getPlatform('magpie-web'),
    });
    // 自研网关原生管理：凭据由适配器自己从各网关工作目录读取，API 层不接触密钥
    this.gatewayPanel = deps.gatewayPanel || new (require('./gateway-panel').GatewayPanel)({
      getPlatform: (id) => deps.store.getPlatform(id),
    });
  }

  listen(listenAddr = '127.0.0.1:17800') {
    const [host, port] = listenAddr.split(':');
    this.server = http.createServer((req, res) => this._handler(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(Number(port), host || '127.0.0.1', () => resolve(this.server.address()));
    });
  }

  /** 纯前端模式：让同一个端口托管 UI 构建产物（SPA 路由回退 index.html） */
  serveStatic(dir) {
    this.deps.staticDir = dir;
  }

  /**
   * 定位 magpie 可执行文件。
   * 优先取 external 平台条目上配置的路径，其次本仓库 tools/magpie/magpie.exe。
   */
  _magpieBinary() {
    const p = this.deps.store && this.deps.store.getPlatform('magpie');
    // 1. 平台配置里显式指定的绝对路径优先（用户可在 platforms.json 里改）
    if (p && p.run && p.run.binary) {
      const raw = String(p.run.binary);
      if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
    }
    // 2. 统一探测（tools/ → 数据目录 → PATH → 标准安装位置）
    return findMagpieBinary(this.deps.store && this.deps.store.dataDir);
  }

  _serveStatic(req, res, dir) {
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
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || !pathExtname(rel)) rel = '/index.html';
    // 去掉前导分隔符：path.resolve(dir, '/x') 在 Windows 上会解析成盘符根 D:\x
    rel = rel.replace(/^[/\\]+/, '');
    const file = path.resolve(dir, rel);
    // 目录穿越防护：不能用 startsWith 比较（`dist-private` 也以 `dist` 开头，
    // 会被判成合法）。改用 path.relative，逃出去时首段是 `..`。
    const base = path.resolve(dir);
    const relToBase = path.relative(base, file);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[pathExtname(file)] || 'application/octet-stream' }).end(buf);
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
    // 写操作的二次来源校验：挡住「任意网页 → Origin=null → 杀进程」的 CSRF
    if ((req.method === 'POST' || req.method === 'PUT') && !isTrustedWrite(origin, req.headers)) {
      return json(res, 403, { error: 'origin not allowed for write' }, null);
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
      if (r === undefined) {
        // 非 /api 路径交给静态托管（纯前端模式下 UI 与 API 同端口）
        if (this.deps.staticDir && req.method === 'GET') {
          return this._serveStatic(req, res, this.deps.staticDir);
        }
        return json(res, 404, { error: `not found: ${req.method} ${u.pathname}` }, origin);
      }
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
        // 上游聚合由 magpie 承担；这里给出它的存活状态，UI 的 Hub 页用它。
        hub: manager.statusOf('magpie'),
      };
    }

    // GET /api/platforms
    if (method === 'GET' && parts[1] === 'platforms' && parts.length === 2) {
      return { platforms: manager.statusList() };
    }

    // 原生插件面板：动作由适配器限定，不允许调用方指定内核 URL。
    if (parts[1] === 'magpie' && parts[2] === 'plugin-panel' && parts.length === 3) {
      const pkg = method === 'GET' ? u.searchParams.get('package') : body.package;
      const provider = method === 'GET' ? u.searchParams.get('provider') : body.provider;
      if (method === 'GET') return this.pluginPanel.detail(pkg, provider);
      if (method === 'POST') return this.pluginPanel.action(pkg, provider, body.action, body);
    }

    // 自研网关原生管理面板（WorkBuddy / CodeArts / Loomy / Lingxi）。
    // 适配器负责目标限定、动作白名单与凭据；这里只做参数转交。
    //   GET  /api/platforms/:id/panel            → 统一只读视图
    //   GET  /api/platforms/:id/panel/logs       → 最近日志
    //   POST /api/platforms/:id/panel            → 受限动作 { action, ... }
    if (parts[1] === 'platforms' && parts[3] === 'panel' && parts.length <= 5) {
      const id = decodeURIComponent(parts[2]);
      if (method === 'GET' && parts[4] === 'logs') {
        return this.gatewayPanel.logs(id, { lines: u.searchParams.get('lines') });
      }
      if (method === 'GET' && parts.length === 4) return this.gatewayPanel.detail(id);
      if (method === 'POST' && parts.length === 4) {
        if (typeof body.action !== 'string') throw new Error('缺少管理动作');
        return this.gatewayPanel.action(id, body.action, body);
      }
    }

    // 路由组：同一模型被多个平台提供时的顺序（只重排、不增删成员）
    if (parts[1] === 'magpie' && parts[2] === 'routing-groups') {
      const groups = this.routingGroups;
      if (method === 'GET') return { groups: await groups.shared(), bindable: await groups.bindable() };
      if (method === 'POST') {
        // action=bind 新建/更新一个只含所选平台的顺序组；否则按 id 重排
        if (body.action === 'bind') {
          const saved = await groups.bind({ id: body.id, name: body.name, providers: body.providers });
          return { saved, groups: await groups.shared() };
        }
        if (typeof body.id !== 'string') throw new Error('缺少路由组标识');
        await groups.reorder(body.id, body.members);
        return { groups: await groups.shared() };
      }
    }

    // GET /api/magpie/providers —— magpie 内核实管的 provider 清单。
    // origin=plugin 表示我们自己接入的四个网关，official 表示 magpie 官方/社区插件。
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'providers') {
      const magpie = require('./magpie-adapter');
      const providers = magpie.listProviders();
      return {
        configDir: magpie.magpieConfigDir(),
        providers,
        pluginCount: providers.filter((p) => p.origin === 'plugin').length,
        officialCount: providers.filter((p) => p.origin === 'official').length,
      };
    }

    // GET /api/magpie/plugins —— 社区插件商城目录（Trae / Qoder / WorkBuddy / Loomy …）
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'plugins') {
      const magpie = require('./magpie-adapter');
      const force = u.searchParams.get('refresh') === '1';
      const data = await magpie.listPluginCatalog({ force });
      const kinds = {};
      for (const p of data.plugins) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
      return { ...data, kinds };
    }

    // POST /api/magpie/plugins/add —— magpie plugin add <package>
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'plugins' && parts[3] === 'add') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const pkg = body && body.package;
      if (!pkg) throw new Error('缺少 package');
      const r = await magpie.addPlugin(bin, pkg);
      return { ok: r.ok, package: pkg, stdout: r.stdout, stderr: r.stderr, __code: r.ok ? 200 : 400 };
    }

    // POST /api/magpie/plugins/remove
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'plugins' && parts[3] === 'remove') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const target = body && (body.spec || body.package || body.name);
      if (!target) throw new Error('缺少插件标识');
      const r = await magpie.removePlugin(bin, target);
      return { ok: r.ok, removed: target, stdout: r.stdout, stderr: r.stderr, __code: r.ok ? 200 : 400 };
    }

    // GET /api/magpie/login/methods?provider=x —— 该 provider 支持的登录方式
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'login' && parts[3] === 'methods') {
      const magpie = require('./magpie-adapter');
      const provider = u.searchParams.get('provider');
      if (!provider) throw new Error('缺少 provider');
      return await magpie.probeLoginMethods(this._magpieBinary(), provider);
    }

    // POST /api/magpie/login —— 启动登录（返回浏览器授权链接）
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'login' && parts.length === 3) {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const { provider, method: loginMethod } = body || {};
      if (!provider) throw new Error('缺少 provider');
      const r = await magpie.startLogin(bin, provider, loginMethod);
      // 拿到链接就顺手在系统浏览器打开，省一次点击
      if (r.url && this.deps.openExternal) {
        try { this.deps.openExternal(r.url); } catch { /* 打开失败不影响流程 */ }
      }
      return r;
    }

    // GET /api/magpie/login/status —— 全部登录流程状态（供轮询）
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'login' && parts[3] === 'status') {
      const magpie = require('./magpie-adapter');
      const provider = u.searchParams.get('provider');
      return provider ? { state: magpie.loginState(provider) } : { states: magpie.listLoginStates() };
    }

    // POST /api/magpie/logout
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'logout') {
      const magpie = require('./magpie-adapter');
      const provider = body && body.provider;
      if (!provider) throw new Error('缺少 provider');
      const r = await magpie.logoutProvider(this._magpieBinary(), provider);
      return { ok: r.ok, provider, stdout: r.stdout, stderr: r.stderr, __code: r.ok ? 200 : 400 };
    }

    // ── magpie 网关自身的可观测数据（无需鉴权，直连 127.0.0.1:3425）──
    // GET /api/magpie/gateway?what=quotas|usage|requests|mcp|statusline|trace
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'gateway') {
      const what = u.searchParams.get('what') || 'overview';
      const period = u.searchParams.get('period') || '7d';
      const limit = Math.min(200, Number(u.searchParams.get('limit')) || 50);
      const base = 'http://127.0.0.1:3425';
      const paths = {
        overview: '/',
        quotas: '/v1/magpie/quotas',
        usage: `/v1/magpie/usage?period=${encodeURIComponent(period)}`,
        requests: `/v1/magpie/usage/requests?period=${encodeURIComponent(period)}&limit=${limit}`,
        mcp: '/v1/magpie/mcp',
        trace: '/v1/magpie/trace',
        statusline: '/v1/magpie/statusline',
      };
      const path = paths[what];
      if (!path) throw new Error(`未知的 magpie 数据源: ${what}`);
      return await new Promise((resolve, reject) => {
        const req = require('http').get(base + path, { timeout: 12000 }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (/text\/plain/.test(res.headers['content-type'] || '')) return resolve({ text: data });
            try { resolve(JSON.parse(data)); }
            catch { resolve({ raw: data.slice(0, 2000) }); }
          });
        });
        req.on('error', (e) => reject(new Error(`连接 magpie 网关失败: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('magpie 网关响应超时')); });
      });
    }

    // POST /api/magpie/install —— 未安装时一键下载 magpie 到数据目录
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'install') {
      const magpie = require('./magpie-adapter');
      if (magpie.installProgress() && magpie.installProgress().status === 'downloading') {
        return { ok: false, message: '已有安装任务在进行中' };
      }
      const dataDir = this.deps.store && this.deps.store.dataDir;
      if (!dataDir) throw new Error('未知数据目录');
      // 后台跑，前端轮询 /api/magpie/install 拿进度
      magpie.installMagpie(dataDir).catch(() => {});
      return { started: true, target: path.join(dataDir, 'magpie') };
    }

    // GET /api/magpie/install —— 安装进度
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'install') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const prog = magpie.installProgress();
      return {
        installed: !!bin,
        binary: bin,
        progress: prog,
        target: this.deps.store && this.deps.store.dataDir
          ? path.join(this.deps.store.dataDir, 'magpie') : null,
      };
    }

    // GET /api/magpie/presets —— magpie 支持的完整 provider 目录（含未安装的）
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'presets') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const force = u.searchParams.get('refresh') === '1';
      const presets = await magpie.listPresets(bin, { force });
      // 已安装 = 出现在 providers.json 或 plugin-providers.json 或内置订阅里
      const installed = new Set(magpie.listProviders().map((p) => p.id));
      return {
        presets: presets.map((p) => ({ ...p, installed: installed.has(p.id) })),
        groups: [...new Set(presets.map((p) => p.group))],
        binary: bin,
      };
    }

    // POST /api/magpie/providers/add —— 用 magpie CLI 安装一个 provider
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'providers' && parts[3] === 'add') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      if (!bin) throw new Error('未找到 magpie 可执行文件');
      const { id, key, args } = body || {};
      if (!id) throw new Error('缺少 provider id');
      const r = await magpie.addProvider(bin, {
        id,
        key: typeof key === 'string' ? key.trim() : '',
        args: Array.isArray(args) ? args : [],
      });
      return { ok: r.ok, id, stdout: r.stdout, stderr: r.stderr, __code: r.ok ? 200 : 400 };
    }

    // POST /api/magpie/providers/remove —— 移除一个 provider
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'providers' && parts[3] === 'remove') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const id = body && body.id;
      if (!id) throw new Error('缺少 provider id');
      const r = await magpie.removeProvider(bin, id);
      return { ok: r.ok, id, stdout: r.stdout, stderr: r.stderr, __code: r.ok ? 200 : 400 };
    }

    // GET /api/magpie/version —— 内核版本与最新 release 对比
    if (method === 'GET' && parts[1] === 'magpie' && parts[2] === 'version') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      const current = await magpie.detectVersion(bin);
      // 优先用 magpie 自己的更新通道（不受 GitHub 60/h 限流），失败再回落 GitHub API
      let latest = await magpie.checkViaCli(bin).catch(() => null);
      if (!latest || (!latest.tag && !latest.upToDate)) {
        const gh = await magpie.latestRelease();
        if (gh && gh.tag) latest = gh;
      }
      return {
        binary: bin || null,
        current,
        latest: latest ? latest.tag || current : null,
        hasUpdate: latest && latest.tag ? magpie.semverGt(latest.tag, current) : false,
        releaseUrl: latest ? latest.url || '' : '',
        checkedAt: Date.now(),
        updating: magpie.isUpdating(),
        lastUpdate: magpie.updateState().last,
      };
    }

    // POST /api/magpie/update —— 直接执行 `magpie update`（下载并替换内核）
    if (method === 'POST' && parts[1] === 'magpie' && parts[2] === 'update') {
      const magpie = require('./magpie-adapter');
      const bin = this._magpieBinary();
      if (!bin) throw new Error('未找到 magpie 可执行文件，无法更新');
      if (magpie.isUpdating()) throw new Error('更新已在进行中');
      // 后台执行，避免 HTTP 请求挂住；结果通过 /api/magpie/version 的 updating 字段观察
      magpie.runUpdate(bin);
      return { ok: true, started: true, binary: bin, message: '已开始下载并安装最新版 magpie 内核' };
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
        if (action === 'start') return manager.start(id, { force: !!(body && body.force) });
        if (action === 'stop') return manager.stop(id);
        if (action === 'restart') return manager.restart(id, { force: !!(body && body.force) });
        if (action === 'enable') return manager.enable(id);
        if (action === 'disable') return manager.disable(id);
        if (action === 'open-panel') {
          const p = store.getPlatform(id);
          if (!p) throw new Error(`未知平台: ${id}`);
          let url = p.adminPanel || `http://127.0.0.1:${p.port}/`;
          // 深链接：magpie-web 支持 ?view=<页面>&edit=<providerId>
          // （前端 syncURL 实现），允许调用方指定落到哪个页面/详情。
          const q = body && body.query;
          if (q && typeof q === 'object' && (id === 'magpie-web' || id === 'magpie')) {
            const u = new URL(url);
            for (const [k, v] of Object.entries(q)) {
              if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
            }
            url = u.toString();
          }
          // magpie-web 深链接：?k=…&view=providers&edit=<id> 一次导航即可。
          // 服务端 303 的 Location 会保留其余参数（实测
          // `Location: /?edit=zcode&view=providers`），前端随后按初始
          // edit 打开该 provider 的详情弹窗。
          if (this.deps.openExternal) this.deps.openExternal(url);
          else if (process.platform === 'win32') {
            // 测试环境无 Electron：start 命令兜底
            require('child_process').exec(`start "" "${url}"`, { windowsHide: true }, () => {});
          } else {
            // Linux/macOS 的对应做法；xdg-open 普遍存在，没有就静默失败
            require('child_process').execFile('xdg-open', [url], () => {});
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

    // GET /api/hub/status —— 聚合层已交给 magpie，这里返回它的存活摘要，
    // 并附上四个自研网关作为 provider 的地址，供 UI 展示接入配置。
    if (method === 'GET' && parts[1] === 'hub' && parts[2] === 'status') {
      if (this.deps.getHubStatus) return this.deps.getHubStatus();
      const magpie = manager.statusOf('magpie');
      const adapter = require('./magpie-adapter');
      const groups = adapter.listGroups();
      const upstreams = manager.statusList()
        .filter((p) => ['workbuddy', 'codearts', 'loomy', 'lingxi'].includes(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: `http://127.0.0.1:${p.port}`,
          state: p.status,
          priority: 1,
          enabled: p.enabled !== false,
          managed: true,
        }));
      return {
        backend: 'magpie',
        status: magpie ? magpie.status : 'unknown',
        gateway: 'http://127.0.0.1:3425',
        listen: '127.0.0.1:3425',
        baseUrl: 'http://127.0.0.1:3425',
        detail: magpie,
        // 路由组（magpie group）→ 页面上的「模型路由表」
        modelRoutes: groups.map((g) => ({
          pattern: `group/${g.name}`,
          chain: g.models,
          routing: g.routing,
        })),
        upstreams,
      };
    }

    // POST /api/hub/reload —— magpie 不归壳管，重载请用 `magpie provider refresh`。
    // 这里改为刷新各上游网关的健康状态，供 UI 一键刷新。
    if (method === 'POST' && parts[1] === 'hub' && parts[2] === 'reload') {
      if (this.deps.reloadHub) return this.deps.reloadHub();
      const refreshed = [];
      for (const p of manager.statusList()) {
        if (p.id === 'magpie') continue;
        try {
          refreshed.push({ id: p.id, state: p.status });
        } catch (e) {
          refreshed.push({ id: p.id, error: e.message });
        }
      }
      return { ok: true, note: '聚合由 magpie 负责；此操作只刷新上游状态', refreshed };
    }

    // GET/PUT /api/settings
    if (parts[1] === 'settings' && parts.length === 2) {
      if (method === 'GET') return store.manager;
      if (method === 'PUT') {
        const cur = store.manager;
        // 合并一级子对象，避免整对象覆盖丢失默认键；proxy.scopes 是二级对象，
        // 单独再合一次——否则前端只发部分范围时，其余项的当前值会被整体丢掉。
        const merged = { ...cur };
        for (const k of Object.keys(body)) {
          if (typeof body[k] === 'object' && body[k] !== null && !Array.isArray(body[k])
            && typeof cur[k] === 'object' && cur[k] !== null) {
            merged[k] = { ...cur[k], ...body[k] };
            if (k === 'proxy' && typeof body.proxy.scopes === 'object' && body.proxy.scopes !== null) {
              merged.proxy.scopes = { ...(cur.proxy && cur.proxy.scopes), ...body.proxy.scopes };
            }
          } else {
            merged[k] = body[k];
          }
        }
        store.manager = merged;
        store.saveManager();
        // 代理范围含 magpie 自己的两项（订阅/插件流量）：保存后同步过去，
        // 由 magpie 执行。同步失败不影响壳设置已保存，只回报一句提示。
        const warnings = [];
        try {
          await syncMagpieProxy(store);
        } catch (e) {
          warnings.push(`magpie 代理设置同步失败：${e.message}`);
        }
        // 壳自更新不吃我们的 http agent，需要重新告诉 electron-updater
        if (this.deps.onSettingsSaved) {
          try { this.deps.onSettingsSaved(); } catch (e) { warnings.push(`应用代理设置失败：${e.message}`); }
        }
        return warnings.length ? { ...store.manager, warnings } : store.manager;
      }
    }


    // POST /api/proxy/verify —— 用给定地址实发一次请求验证代理是否可用。
    // 目标固定为 GitHub API（壳最需要代理的地方），不接受调用方指定，
    // 免得把它当成任意 URL 的探针。
    if (method === 'POST' && parts[1] === 'proxy' && parts[2] === 'verify') {
      const proxy = require('./proxy');
      const url = body && typeof body.url === 'string' ? body.url.trim() : '';
      if (!url) throw new Error('请先填写代理地址');
      return proxy.verify(url);
    }

    // POST /api/shell/update/check —— 壳自身更新检查。
    // 壳不是平台（platforms.json 里没有它），走 electron-updater，因此不能
    // 借用 /api/platforms/:id/update/check（早先前端拿 'hub' 当占位，而自研
    // Hub 早已移除，于是永远 404「未知平台: hub」）。
    if (method === 'POST' && parts[1] === 'shell' && parts[2] === 'update' && parts[3] === 'check') {
      if (!this.deps.selfUpdate) throw new Error('壳自更新在当前平台不可用');
      return this.deps.selfUpdate.check();
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
        // run.env 里可能有 MAGPIE_WEB_KEY 这类会话密钥：只回传键名，
        // 值一律不回显（前端也不需要它们来启停平台）。
        run: p.run ? { ...p.run, env: Object.fromEntries(Object.keys(p.run.env || {}).map((k) => [k, ''])) } : p.run,
        port: p.port,
        health: p.health,
        // adminPanel 可能带 ?k=<密钥>，去掉查询串再给前端
        adminPanel: typeof p.adminPanel === 'string' ? p.adminPanel.split('?')[0] : p.adminPanel,
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
