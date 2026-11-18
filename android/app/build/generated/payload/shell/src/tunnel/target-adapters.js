'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { TunnelError, targetOf } = require('./targets');

const ROUTES = {
  workbuddy: [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/messages'],
    ['POST', '/v1/messages/count_tokens'], ['POST', '/v1/responses'],
    ['POST', '/v1/videos/generations'], ['POST', '/v1/videos/tasks'], ['GET', /^\/v1\/videos\/[^/]+$/],
  ],
  codearts: [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'],
    ['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'],
  ],
  loomy: [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/messages'],
    ['POST', '/v1/embeddings'], ['POST', '/v1/images/generations'],
  ],
  lingxi: [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/search/messages'],
  ],
  magpie: [
    ['GET', '/v1/models'], ['GET', /^\/v1\/models\/.+$/],
    ['POST', '/v1/chat/completions'], ['POST', '/v1/responses'], ['GET', '/v1/responses'],
    ['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['POST', '/v1/systemone'],
    ['POST', '/v1/images/generations'], ['POST', '/v1/images/edits'],
    ['POST', '/v1/embeddings'], ['POST', '/v1/rerank'], ['POST', '/v1/decisions'],
    ['POST', '/v1/audio/transcriptions'], ['POST', '/v1/audio/translations'], ['POST', '/v1/audio/speech'],
    ['POST', '/v1/videos'], ['GET', /^\/v1\/videos\/[^/]+$/], ['GET', /^\/v1\/videos\/[^/]+\/content$/],
    ['GET', '/v1beta/models'], ['POST', /^\/v1beta\/models\/.+$/],
  ],
};

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function expandPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/%([^%]+)%/g, (match, key) => process.env[key] || match);
}

function portFromListen(listen, fallback) {
  const text = String(listen || '').trim();
  const match = text.match(/:(\d+)$/) || text.match(/^(\d+)$/);
  const port = match ? Number(match[1]) : Number(fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelError('TARGET_UNAVAILABLE', '目标网关端口配置无效', 503);
  }
  return port;
}

function keyFromHeaders(headers) {
  const candidates = [];
  const auth = String(headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) candidates.push(auth.replace(/^Bearer\s+/i, '').trim());
  for (const name of ['x-api-key', 'x-goog-api-key']) {
    const value = String(headers[name] || '').trim();
    if (value) candidates.push(value);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestModels(origin, key, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL('/v1/models', origin), {
      headers: { Authorization: `Bearer ${key}` }, timeout: timeoutMs,
    }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class TargetAdapters {
  constructor({ getPlatform, env = process.env, magpieDir, request = requestModels, resolveWorkDir } = {}) {
    if (typeof getPlatform !== 'function') throw new TypeError('TargetAdapters 需要 getPlatform');
    this.getPlatform = getPlatform;
    this.env = env;
    this.magpieDir = magpieDir;
    this.request = request;
    this.resolveWorkDir = resolveWorkDir || ((platform) => expandPath(platform.workDir));
    this.configCache = new Map();
  }

  _readJson(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return {}; }
    const previous = this.configCache.get(file);
    if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return previous.value;
    const value = readJson(file);
    this.configCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  _platform(id) {
    const platform = this.getPlatform(id);
    if (!platform) throw new TunnelError('TARGET_UNAVAILABLE', `未配置目标平台: ${id}`, 503);
    return platform;
  }

  _config(id) {
    const platform = this._platform(id);
    if (!platform.workDir) return {};
    return this._readJson(path.join(this.resolveWorkDir(platform), 'config.json'));
  }

  _env(platform) {
    return { ...this.env, ...((platform.run && platform.run.env) || {}) };
  }

  upstreamOrigin(id) {
    const target = targetOf(id);
    const platform = this._platform(id);
    let port = Number(platform.port || target.upstreamPort);
    if (id === 'loomy') {
      const config = this._config(id);
      port = portFromListen(this._env(platform).LOOMY_PORT || config.port || platform.port, target.upstreamPort);
    } else if (id !== 'magpie') {
      const config = this._config(id);
      port = portFromListen(this._env(platform)[id === 'codearts' ? 'CA2A_LISTEN' : 'WB2A_LISTEN'] || config.listen || platform.port, target.upstreamPort);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TunnelError('TARGET_UNAVAILABLE', '目标网关端口配置无效', 503);
    return `http://127.0.0.1:${port}`;
  }

  validKeys(id) {
    const platform = this._platform(id);
    const env = this._env(platform);
    const config = this._config(id);
    let keys = [];
    if (id === 'workbuddy') {
      keys.push(env.WB2A_API_KEY || config.api_key || '');
      for (const item of Array.isArray(config.api_keys) ? config.api_keys : []) {
        keys.push(typeof item === 'string' ? item : item && item.key);
      }
    } else if (id === 'codearts') {
      // admin_key 只用于管理接口，绝不能替代普通 API Key。
      keys.push(env.CA2A_API_KEY || config.api_key || '');
    } else if (id === 'loomy') {
      const raw = env.LOOMY_API_KEYS || env.API_KEY || config.api_keys || [];
      keys = Array.isArray(raw) ? raw : String(raw).split(',');
    } else if (id === 'lingxi') {
      keys.push(env.WB2A_API_KEY || config.api_key || '');
    } else if (id === 'magpie') {
      const dir = this.magpieDir || require('../magpie-adapter').magpieConfigDir();
      const store = this._readJson(path.join(dir, 'caller-keys.json'));
      const now = Date.now();
      for (const item of Array.isArray(store) ? store : []) {
        if (!item || item.off || !item.secret) continue;
        if (item.expires && Date.parse(item.expires) <= now) continue;
        keys.push(item.secret);
      }
      const settings = this._readJson(path.join(dir, 'settings.json'));
      if (settings.lan && !settings.lanKeyId && settings.lanKey
        && !String(settings.lanKey).startsWith('sk-magpie-revoked-')) keys.push(settings.lanKey);
    }
    return [...new Set(keys.filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()))];
  }

  authorize(id, headers) {
    const presented = keyFromHeaders(headers || {});
    const valid = this.validKeys(id);
    for (const candidate of presented) {
      for (const expected of valid) if (safeEqual(candidate, expected)) return candidate;
    }
    return '';
  }

  routeAllowed(id, method, pathname) {
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) return false;
    return (ROUTES[id] || []).some(([allowedMethod, route]) => allowedMethod === method
      && (typeof route === 'string' ? route === pathname : route.test(pathname)));
  }

  async preflight(id) {
    targetOf(id);
    const platform = this._platform(id);
    if (platform.enabled === false) throw new TunnelError('PLATFORM_DISABLED', '目标平台已禁用，请先在本机启用', 409);
    const origin = this.upstreamOrigin(id);
    const keys = this.validKeys(id);
    if (!keys.length) {
      const hint = id === 'magpie' ? '请先在 magpie 的 Gateway keys 中创建并启用一个 Key' : '请先在目标网关中配置普通 API Key';
      throw new TunnelError('API_KEY_REQUIRED', hint, 409);
    }
    let status;
    try { status = await this.request(origin, keys[0]); } catch {
      throw new TunnelError('TARGET_UNAVAILABLE', '目标服务无法从本机访问，请先确认它正在运行', 503);
    }
    if (status === 401 || status === 403) throw new TunnelError('API_KEY_INVALID', '目标服务拒绝了现有 API Key，请检查配置', 409);
    if (status === 404) throw new TunnelError('ROUTE_UNSUPPORTED', '目标服务不支持 /v1/models，不能安全开放', 409);
    return { ok: true, id, origin, keyVerified: true, targetStatus: status, localHealth: status < 400 ? 'ok' : 'degraded' };
  }
}

module.exports = { TargetAdapters, ROUTES, keyFromHeaders, safeEqual, portFromListen };
