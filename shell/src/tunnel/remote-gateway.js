'use strict';

const http = require('http');
const net = require('net');
const { TunnelError } = require('./targets');

const SESSION_COOKIE = '__Host-wanneng_session';
const CSRF_COOKIE = '__Host-wanneng_csrf';
const LOGIN_PATH = '/__wanneng_tunnel_login';
const LOGOUT_PATH = '/__wanneng_tunnel_logout';
const SESSION_PATH = '/__wanneng_tunnel_session';
const HEALTH_PATH = '/__wanneng_tunnel_health';
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

function json(res, status, value, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'", ...extraHeaders,
  });
  res.end(body);
}

function loginHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wanneng2API 远程登录</title><style>body{font-family:system-ui;background:#111723;color:#e8eefc;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#192238;border:1px solid #31405f;border-radius:14px;padding:28px;width:min(360px,calc(100vw - 48px))}h1{font-size:20px}input,button{box-sizing:border-box;width:100%;padding:11px;border-radius:8px;border:1px solid #405175;font-size:14px}input{background:#0e1626;color:inherit;margin:8px 0 14px}button{background:#4b83ec;color:white;border:0;cursor:pointer}#error{color:#ff9a9a;min-height:22px;font-size:13px}small{color:#93a4c4}</style></head><body><form class="card" id="login"><h1>Wanneng2API</h1><p>远程管理台需要管理员验证。</p><label>用户名<input name="username" value="admin" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">登录</button><p id="error" role="alert"></p><small>凭据仅提交到当前 HTTPS 管理台，不写入浏览器存储。</small></form><script>document.getElementById('login').addEventListener('submit',async(e)=>{e.preventDefault();const out=document.getElementById('error');out.textContent='正在验证…';const form=new FormData(e.target);try{const res=await fetch('${LOGIN_PATH}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.get('username'),password:form.get('password')})});const data=await res.json();if(!res.ok)throw new Error(data.error||'登录失败');location.replace('/')}catch(err){out.textContent=err.message}})</script></body></html>`;
}

function readJsonBody(req, maxBytes = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new TunnelError('BODY_TOO_LARGE', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch {
        reject(new TunnelError('INVALID_JSON', '请求 JSON 无效'));
      }
    });
    req.on('error', reject);
  });
}

function cookie(name, value, httpOnly, clear = false) {
  return `${name}=${clear ? '' : value}; Path=/; Secure; SameSite=Strict; ${httpOnly ? 'HttpOnly; ' : ''}Max-Age=${clear ? 0 : 43200}`;
}

class RemoteGateway {
  constructor({ auth, managerOrigin = 'http://127.0.0.1:17800', publicUrl = '', host = '127.0.0.1', port = 0 } = {}) {
    if (!auth) throw new TypeError('RemoteGateway 需要 RemoteAuth');
    this.auth = auth;
    this.managerOrigin = managerOrigin;
    this.publicUrl = publicUrl;
    this.host = host;
    this.port = port;
    this.server = null;
    this.sockets = new Set();
  }

  setPublicUrl(value) {
    this.publicUrl = value;
  }

  async listen() {
    if (this.server) return this.address();
    this.server = http.createServer((req, res) => this._handler(req, res));
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 30 * 1000;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.address();
  }

  address() {
    return this.server ? this.server.address() : null;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.auth.revokeAll();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  _originAllowed(req) {
    if (!this.publicUrl) return false;
    return String(req.headers.origin || '').replace(/\/$/, '') === this.publicUrl.replace(/\/$/, '');
  }

  _hostAllowed(req) {
    if (!this.publicUrl) return false;
    return String(req.headers.host || '').toLowerCase() === new URL(this.publicUrl).host.toLowerCase();
  }

  _securityReady(req, res) {
    if (!this.publicUrl) {
      json(res, 503, { error: '公网地址尚未就绪' });
      return false;
    }
    if (!this._hostAllowed(req) || req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: '请求来源无效' });
      return false;
    }
    return true;
  }

  async _handler(req, res) {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === HEALTH_PATH) return json(res, 200, { ok: true });
      if (!this._securityReady(req, res)) return;
      if (pathname === LOGIN_PATH && req.method === 'POST') return await this._login(req, res);
      if (pathname === SESSION_PATH && req.method === 'GET') {
        const session = this.auth.authenticate(req);
        if (!session) return json(res, 401, { authenticated: false });
        return json(res, 200, { authenticated: true, expires: session.expires });
      }
      const session = this.auth.authenticate(req);
      if (pathname === LOGOUT_PATH && req.method === 'POST') {
        if (!session) return json(res, 401, { error: '登录已失效' });
        if (!this._originAllowed(req) || !this.auth.checkCsrf(req, session)) {
          return json(res, 403, { error: 'CSRF 或 Origin 校验失败' });
        }
        this.auth.logout(req);
        return json(res, 200, { ok: true }, {
          'Set-Cookie': [cookie(SESSION_COOKIE, '', true, true), cookie(CSRF_COOKIE, '', false, true)],
        });
      }
      if (!session) {
        if (pathname.startsWith('/api/')) return json(res, 401, { error: '请先登录' });
        if (req.method === 'GET' && (pathname === '/' || !pathname.includes('.'))) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            'X-Frame-Options': 'DENY',
          });
          return res.end(loginHtml());
        }
        return json(res, 401, { error: '请先登录' });
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        && (!this._originAllowed(req) || !this.auth.checkCsrf(req, session))) {
        return json(res, 403, { error: 'CSRF 或 Origin 校验失败' });
      }
      if (req.method === 'OPTIONS') return json(res, 403, { error: '不开放跨域请求' });
      return this._proxy(req, res);
    } catch (error) {
      return json(res, error.statusCode || 400, { error: error.message || '请求失败' });
    }
  }

  async _login(req, res) {
    if (!this._originAllowed(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 403, { error: '登录请求来源无效' });
    }
    const body = await readJsonBody(req);
    const forwarded = String(req.headers['cf-connecting-ip'] || '').trim();
    const ip = net.isIP(forwarded) ? forwarded : (req.socket.remoteAddress || 'unknown');
    const session = await this.auth.login(body.username, body.password, ip);
    return json(res, 200, { ok: true, expires: session.expires, csrfToken: session.csrfToken }, {
      'Set-Cookie': [cookie(SESSION_COOKIE, session.sessionId, true), cookie(CSRF_COOKIE, session.csrfToken, false)],
    });
  }

  _proxy(req, res) {
    const manager = new URL(this.managerOrigin);
    const headers = { ...req.headers, host: manager.host, origin: manager.origin,
      'x-wanneng-client': 'wanneng2api', 'accept-encoding': 'identity' };
    for (const name of HOP_BY_HOP) delete headers[name];
    for (const name of Object.keys(headers)) {
      if (/^(?:cf-|x-forwarded|x-real-ip|forwarded$|true-client-ip|sec-fetch-)/i.test(name)
        || /^(?:cookie|x-wanneng-csrf)$/i.test(name)) delete headers[name];
    }
    const requestPath = new URL(req.url, 'http://127.0.0.1');
    const upstream = (manager.protocol === 'https:' ? require('https') : http).request(new URL(requestPath.pathname + requestPath.search, manager), {
      method: req.method, headers,
    }, (response) => {
      const responseHeaders = { ...response.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      delete responseHeaders['access-control-allow-origin'];
      responseHeaders['x-frame-options'] = 'DENY';
      responseHeaders['content-security-policy'] = "frame-ancestors 'none'; base-uri 'none'";
      if (String(responseHeaders['content-type'] || '').includes('text/event-stream')) {
        responseHeaders['cache-control'] = 'no-cache, no-transform';
        responseHeaders['x-accel-buffering'] = 'no';
        responseHeaders.connection = 'keep-alive';
      }
      res.writeHead(response.statusCode || 502, responseHeaders);
      if (String(responseHeaders['content-type'] || '').includes('text/event-stream')) res.flushHeaders();
      response.on('error', () => { upstream.destroy(); res.destroy(); });
      response.on('aborted', () => { upstream.destroy(); res.destroy(); });
      response.pipe(res);
    });
    upstream.setTimeout(120000, () => upstream.destroy(new Error('upstream inactivity timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: '本机 Manager API 不可用' });
      else if (!res.writableEnded) res.destroy();
    });
    res.on('close', () => { if (!upstream.readableEnded) upstream.destroy(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
}

module.exports = { RemoteGateway, loginHtml, readJsonBody, cookie };
