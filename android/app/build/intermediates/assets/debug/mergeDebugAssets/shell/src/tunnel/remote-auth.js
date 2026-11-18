'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { TunnelError } = require('./targets');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_GLOBAL_IN_FLIGHT = 4;
const MAX_IP_IN_FLIGHT = 2;
const MAX_IP_BUCKETS = 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function sameHash(a, b) {
  const left = Buffer.isBuffer(a) ? a : digest(a);
  const right = Buffer.isBuffer(b) ? b : digest(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class RemoteAuth {
  constructor({ store, now = () => Date.now(), sessionTtlMs = SESSION_TTL } = {}) {
    if (!store) throw new TypeError('RemoteAuth 需要 TunnelStore');
    this.store = store;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
    this.ipFailures = new Map();
    this.globalFailures = [];
    this.inFlight = 0;
    this.ipInFlight = new Map();
  }

  get passwordConfigured() {
    return !!this.store.getManagerPassword();
  }

  async _derive(password, record) {
    if (record.algorithm !== 'scrypt' || record.N !== 16384 || record.r !== 8 || record.p !== 1
      || record.keyLength !== 64 || typeof record.salt !== 'string' || typeof record.hash !== 'string') {
      throw new TunnelError('PASSWORD_RECORD_INVALID', '管理台密码记录无效，请在本机重新设置', 500);
    }
    return scrypt(String(password), Buffer.from(record.salt, 'base64'), 64, {
      N: record.N, r: record.r, p: record.p, maxmem: 64 * 1024 * 1024,
    });
  }

  async setPassword(currentPassword, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 256) {
      throw new TunnelError('PASSWORD_TOO_SHORT', '远程管理密码长度必须为 12-256 位');
    }
    const existing = this.store.getManagerPassword();
    if (existing) {
      const derived = await this._derive(currentPassword || '', existing);
      const expected = Buffer.from(existing.hash, 'base64');
      if (!sameHash(derived, expected)) throw new TunnelError('PASSWORD_INVALID', '当前密码不正确', 401);
    }
    const salt = crypto.randomBytes(16);
    const record = {
      algorithm: 'scrypt', N: 16384, r: 8, p: 1, keyLength: 64,
      salt: salt.toString('base64'), hash: '', updatedAt: this.now(),
    };
    const derived = await this._derive(newPassword, record);
    record.hash = derived.toString('base64');
    this.store.setManagerPassword(record);
    this.revokeAll();
    return { configured: true, updatedAt: record.updatedAt };
  }

  async verifyPassword(password) {
    const record = this.store.getManagerPassword();
    if (!record) throw new TunnelError('PASSWORD_REQUIRED', '请先在本机设置远程管理密码', 409);
    const derived = await this._derive(password || '', record);
    return sameHash(derived, Buffer.from(record.hash, 'base64'));
  }

  _bucket(ip) {
    return this.ipFailures.get(ip) || { failures: [], blockedUntil: 0 };
  }

  _checkRate(ip) {
    const now = this.now();
    for (const [key, bucket] of this.ipFailures) {
      bucket.failures = bucket.failures.filter((at) => now - at < 10 * 60 * 1000);
      if (!bucket.failures.length && bucket.blockedUntil <= now && !this.ipInFlight.get(key)) this.ipFailures.delete(key);
    }
    while (this.ipFailures.size > MAX_IP_BUCKETS) {
      const oldest = this.ipFailures.keys().next().value;
      this.ipFailures.delete(oldest);
    }
    const bucket = this._bucket(ip);
    this.globalFailures = this.globalFailures.filter((at) => now - at < 10 * 60 * 1000);
    if (bucket.blockedUntil > now || this.globalFailures.length >= 30
      || this.inFlight >= MAX_GLOBAL_IN_FLIGHT || (this.ipInFlight.get(ip) || 0) >= MAX_IP_IN_FLIGHT) {
      throw new TunnelError('LOGIN_RATE_LIMITED', '登录尝试过多，请稍后再试', 429);
    }
  }

  _enter(ip) {
    this.inFlight++;
    this.ipInFlight.set(ip, (this.ipInFlight.get(ip) || 0) + 1);
  }

  _leave(ip) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const remaining = (this.ipInFlight.get(ip) || 1) - 1;
    if (remaining > 0) this.ipInFlight.set(ip, remaining);
    else this.ipInFlight.delete(ip);
  }

  _failed(ip) {
    const now = this.now();
    const bucket = this._bucket(ip);
    bucket.failures = [...bucket.failures.filter((at) => now - at < 10 * 60 * 1000), now];
    if (bucket.failures.length >= 5) {
      bucket.blockedUntil = now + 60 * 1000;
      bucket.failures = [];
    }
    this.ipFailures.set(ip, bucket);
    this.globalFailures.push(now);
  }

  async login(username, password, ip = 'unknown') {
    this._checkRate(ip);
    this._enter(ip);
    try {
      let valid = false;
      try { valid = username === 'admin' && await this.verifyPassword(password); } catch (error) {
        if (error.code === 'PASSWORD_REQUIRED') throw error;
      }
      if (!valid) {
        this._failed(ip);
        throw new TunnelError('LOGIN_INVALID', '用户名或密码不正确', 401);
      }
      this.ipFailures.delete(ip);
      this._prune();
      const sessionId = randomToken();
      const csrfToken = randomToken();
      const expires = this.now() + this.sessionTtlMs;
      this.sessions.set(digest(sessionId).toString('hex'), {
        csrfHash: digest(csrfToken).toString('hex'),
        createdAt: this.now(), expires,
      });
      return { sessionId, csrfToken, expires };
    } finally {
      this._leave(ip);
    }
  }

  _prune() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }

  authenticate(req) {
    const sessionId = parseCookies(req.headers.cookie)['__Host-wanneng_session'];
    if (!sessionId) return null;
    const key = digest(sessionId).toString('hex');
    const session = this.sessions.get(key);
    if (!session || session.expires <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return { key, expires: session.expires };
  }

  checkCsrf(req, session) {
    if (!session) return false;
    const stored = this.sessions.get(session.key);
    const token = req.headers['x-wanneng-csrf'];
    return !!stored && !!token && sameHash(digest(token).toString('hex'), stored.csrfHash);
  }

  logout(req) {
    const session = this.authenticate(req);
    if (session) this.sessions.delete(session.key);
  }

  revokeAll() {
    this.sessions.clear();
  }
}

module.exports = { RemoteAuth, parseCookies, digest, sameHash };
