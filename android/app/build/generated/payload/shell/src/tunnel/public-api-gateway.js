'use strict';

const http = require('http');
const { Transform } = require('stream');
const { TunnelError, targetOf } = require('./targets');

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
const SECRET_QUERY = ['key', 'api_key', 'apikey', 'access_token'];

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function cleanPath(reqUrl) {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  if (/%(?:2e|2f|5c)/i.test(String(reqUrl).split('?')[0])) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  // 解码后仍带编码属于双重编码；点段也必须在转发前拒绝，避免 URL 二次规范化绕过白名单。
  if (/%[0-9a-f]{2}/i.test(pathname) || pathname.includes('\0') || pathname.includes('\\')
    || pathname.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  for (const key of SECRET_QUERY) url.searchParams.delete(key);
  return { pathname, search: url.search };
}

function upstreamHeaders(req, origin, key) {
  const headers = { ...req.headers, host: new URL(origin).host, authorization: `Bearer ${key}`, 'accept-encoding': 'identity' };
  for (const name of HOP_BY_HOP) delete headers[name];
  for (const name of Object.keys(headers)) {
    if (/^(?:cf-|x-forwarded|x-real-ip|forwarded$|true-client-ip|tailscale-user-login|sec-fetch-)/i.test(name)
      || /^(?:cookie|x-api-key|x-goog-api-key|api-key|apikey|origin)$/i.test(name)) delete headers[name];
  }
  return headers;
}

class PublicApiGateway {
  constructor({ targetId, adapters, host = '127.0.0.1', port = 0, maxBodyBytes = 64 * 1024 * 1024 } = {}) {
    this.target = targetOf(targetId);
    if (this.target.kind !== 'api') throw new TypeError('PublicApiGateway 只接受 API 目标');
    this.adapters = adapters;
    this.host = host;
    this.port = port;
    this.maxBodyBytes = maxBodyBytes;
    this.server = null;
    this.sockets = new Set();
  }

  async listen() {
    if (this.server) return this.address();
    this.server = http.createServer((req, res) => this._handler(req, res));
    this.server.requestTimeout = 10 * 60 * 1000;
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
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async _handler(req, res) {
    try {
      const parsed = cleanPath(req.url);
      if (!parsed) return json(res, 400, { error: { code: 'INVALID_PATH', message: '请求路径无效' } });
      if (req.method === 'GET' && parsed.pathname === '/__wanneng_tunnel_health') {
        return json(res, 200, { ok: true });
      }
      if (!this.adapters.routeAllowed(this.target.id, req.method, parsed.pathname)) {
        return json(res, 404, { error: { code: 'ROUTE_NOT_PUBLIC', message: '此路径不对外开放' } });
      }
      const key = this.adapters.authorize(this.target.id, req.headers);
      if (!key) return json(res, 401, { error: { code: 'INVALID_API_KEY', message: '缺少或无效的 API Key' } });
      return this._proxy(req, res, parsed, key);
    } catch (error) {
      return json(res, error.statusCode || 502, {
        error: { code: error.code || 'UPSTREAM_UNAVAILABLE', message: '上游服务暂时不可用' },
      });
    }
  }

  _proxy(req, res, parsed, key) {
    const origin = this.adapters.upstreamOrigin(this.target.id);
    const upstream = http.request(new URL(parsed.pathname + parsed.search, origin), {
      method: req.method,
      headers: upstreamHeaders(req, origin, key),
      timeout: 10 * 60 * 1000,
    }, (response) => {
      const headers = { ...response.headers };
      for (const name of HOP_BY_HOP) delete headers[name];
      if (String(headers['content-type'] || '').includes('text/event-stream')) {
        headers['cache-control'] = 'no-cache, no-transform';
        headers['x-accel-buffering'] = 'no';
        headers.connection = 'keep-alive';
      }
      res.writeHead(response.statusCode || 502, headers);
      if (String(headers['content-type'] || '').includes('text/event-stream')) res.flushHeaders();
      response.on('error', () => { upstream.destroy(); res.destroy(); });
      response.on('aborted', () => { upstream.destroy(); res.destroy(); });
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: { code: 'UPSTREAM_UNAVAILABLE', message: '上游服务暂时不可用' } });
      else if (!res.writableEnded) res.destroy();
    });
    res.on('close', () => { if (!upstream.readableEnded) upstream.destroy(); });

    let size = 0;
    const maxBodyBytes = this.maxBodyBytes;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxBodyBytes) return callback(new TunnelError('BODY_TOO_LARGE', '请求体过大', 413));
        callback(null, chunk);
      },
    });
    limiter.on('error', () => {
      upstream.destroy();
      if (!res.headersSent) json(res, 413, { error: { code: 'BODY_TOO_LARGE', message: '请求体过大' } });
      else if (!res.writableEnded) res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(limiter).pipe(upstream);
  }
}

module.exports = { PublicApiGateway, cleanPath, upstreamHeaders };
