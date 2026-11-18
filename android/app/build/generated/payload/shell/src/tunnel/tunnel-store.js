'use strict';

const fs = require('fs');
const path = require('path');
const {
  TARGETS,
  TunnelError,
  targetOf,
  defaultTargetConfig,
  normalizeTargetConfig,
  normalizePublicUrl,
  normalizeGuardPort,
  normalizeToken,
  tokenFingerprint,
  parseNamedTokenInfo,
  validateUnique,
  startConfig,
} = require('./targets');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultPublic() {
  const targets = {};
  for (const target of TARGETS) targets[target.id] = defaultTargetConfig(target.id);
  return { version: 1, targets };
}

function defaultPrivate() {
  return { version: 1, tokens: {}, verification: {}, managerPassword: null };
}

function writeAtomic(file, value, { privateFile = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: privateFile ? 0o700 : 0o755 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', privateFile ? 0o600 : 0o644);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    if (privateFile && process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* ignore */ }
  }
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new TunnelError('CONFIG_CORRUPT', `隧道配置损坏，已停止加载且不会覆盖原文件: ${path.basename(file)}`, 500);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TunnelError('CONFIG_CORRUPT', `隧道配置格式无效: ${path.basename(file)}`, 500);
  }
  return parsed;
}

class TunnelStore {
  constructor(dataDir, options = {}) {
    if (!dataDir) throw new TypeError('TunnelStore 需要 dataDir');
    this.dataDir = dataDir;
    this.publicPath = path.join(dataDir, 'tunnels.json');
    this.privatePath = path.join(dataDir, 'private', 'tunnel-secrets.json');
    this._writeAtomic = options.writeAtomic || writeAtomic;
    const pub = readJson(this.publicPath, defaultPublic());
    const secrets = readJson(this.privatePath, defaultPrivate());
    this._public = this._normalizePublic(pub);
    this._private = this._normalizePrivate(secrets);
    validateUnique(this._public.targets, this._private);
  }

  _normalizePublic(value) {
    const defaults = defaultPublic();
    const source = value.targets && typeof value.targets === 'object' && !Array.isArray(value.targets)
      ? value.targets : {};
    for (const target of TARGETS) {
      defaults.targets[target.id] = normalizeTargetConfig(target.id, {
        ...defaults.targets[target.id],
        ...(source[target.id] || {}),
      });
    }
    return { version: 1, targets: defaults.targets };
  }

  _normalizePrivate(value) {
    const tokens = {};
    const input = value.tokens && typeof value.tokens === 'object' && !Array.isArray(value.tokens)
      ? value.tokens : {};
    for (const target of TARGETS) {
      if (input[target.id] === undefined || input[target.id] === '') continue;
      tokens[target.id] = normalizeToken(input[target.id]);
    }
    const verification = {};
    const verificationInput = value.verification && typeof value.verification === 'object' && !Array.isArray(value.verification)
      ? value.verification : {};
    for (const target of TARGETS) {
      const record = verificationInput[target.id];
      if (record === undefined) continue;
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isFinite(Number(record.verifiedAt)) || Number(record.verifiedAt) <= 0
        || typeof record.tunnelId !== 'string' || !record.tunnelId
        || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint)) {
        throw new TunnelError('CONFIG_CORRUPT', 'Tunnel Token 验证记录格式无效', 500);
      }
      verification[target.id] = {
        verifiedAt: Number(record.verifiedAt), tunnelId: record.tunnelId, fingerprint: record.fingerprint,
      };
    }
    const managerPassword = value.managerPassword == null ? null : value.managerPassword;
    if (managerPassword !== null && (typeof managerPassword !== 'object' || Array.isArray(managerPassword))) {
      throw new TunnelError('CONFIG_CORRUPT', '管理台密码记录格式无效', 500);
    }
    return { version: 1, tokens, verification, managerPassword: clone(managerPassword) };
  }

  list() {
    return TARGETS.map((target) => ({
      ...clone(this._public.targets[target.id]),
      id: target.id,
      hasToken: !!this._private.tokens[target.id],
      verifiedAt: this._private.verification[target.id]?.verifiedAt || 0,
      tunnelId: this._private.verification[target.id]?.tunnelId || '',
      ...(target.kind === 'manager' ? { passwordConfigured: !!this._private.managerPassword } : {}),
    }));
  }

  get(id) {
    targetOf(id);
    const found = this.list().find((item) => item.id === id);
    return found;
  }

  getToken(id) {
    targetOf(id);
    return this._private.tokens[id] || '';
  }

  secretValues() {
    return Object.values(this._private.tokens).filter(Boolean);
  }

  getStartConfig(id) {
    targetOf(id);
    return startConfig(id, this._public.targets[id], this._private);
  }

  updateTarget(id, patch = {}) {
    targetOf(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TunnelError('INVALID_CONFIG', '隧道配置必须是对象');
    }
    const allowed = new Set(['mode', 'autoStart', 'publicUrl', 'guardPort', 'token']);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) throw new TunnelError('INVALID_CONFIG', `不支持的隧道配置字段: ${key}`);
    }
    const nextPublic = clone(this._public);
    const nextPrivate = clone(this._private);
    const current = nextPublic.targets[id];
    if (patch.mode !== undefined) current.mode = patch.mode;
    if (patch.autoStart !== undefined) {
      if (typeof patch.autoStart !== 'boolean') throw new TunnelError('INVALID_CONFIG', 'autoStart 必须是布尔值');
      current.autoStart = patch.autoStart;
    }
    if (patch.publicUrl !== undefined) current.publicUrl = normalizePublicUrl(patch.publicUrl);
    if (patch.guardPort !== undefined) current.guardPort = normalizeGuardPort(patch.guardPort);
    const normalized = normalizeTargetConfig(id, current);
    normalized.updatedAt = Date.now();
    nextPublic.targets[id] = normalized;
    if (patch.token !== undefined) {
      const previousToken = nextPrivate.tokens[id] || '';
      const nextToken = patch.token === null || patch.token === '' ? '' : normalizeToken(patch.token);
      if (previousToken !== nextToken) delete nextPrivate.verification[id];
      if (nextToken) nextPrivate.tokens[id] = nextToken;
      else delete nextPrivate.tokens[id];
    }
    validateUnique(nextPublic.targets, nextPrivate);
    this._commit(nextPublic, nextPrivate);
    return this.get(id);
  }

  markTokenVerified(id, { token, tunnelId, expectedUpdatedAt } = {}) {
    targetOf(id);
    if (expectedUpdatedAt !== undefined && this._public.targets[id].updatedAt !== expectedUpdatedAt) {
      throw new TunnelError('TOKEN_CHANGED', '验证期间配置已变化，请重新验证', 409);
    }
    const info = parseNamedTokenInfo(token);
    if (info.tunnelId !== tunnelId) throw new TunnelError('TOKEN_CHANGED', '验证结果与当前 Tunnel 不一致', 409);
    const nextPrivate = clone(this._private);
    nextPrivate.tokens[id] = normalizeToken(token);
    nextPrivate.verification[id] = {
      verifiedAt: Date.now(), tunnelId, fingerprint: tokenFingerprint(token),
    };
    validateUnique(this._public.targets, nextPrivate);
    this._commit(this._public, nextPrivate);
    return this.get(id);
  }

  getManagerPassword() {
    return clone(this._private.managerPassword);
  }

  setManagerPassword(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TunnelError('INVALID_PASSWORD_RECORD', '管理台密码记录无效');
    }
    const nextPrivate = clone(this._private);
    nextPrivate.managerPassword = clone(record);
    this._commit(this._public, nextPrivate);
  }

  _commit(nextPublic, nextPrivate) {
    const publicChanged = JSON.stringify(nextPublic) !== JSON.stringify(this._public);
    const privateChanged = JSON.stringify(nextPrivate) !== JSON.stringify(this._private);
    if (!publicChanged && !privateChanged) return;
    let privateWritten = false;
    try {
      if (privateChanged) {
        this._writeAtomic(this.privatePath, nextPrivate, { privateFile: true });
        privateWritten = true;
      }
      if (publicChanged) this._writeAtomic(this.publicPath, nextPublic, { privateFile: false });
    } catch (error) {
      if (privateWritten) {
        try { this._writeAtomic(this.privatePath, this._private, { privateFile: true }); } catch { /* 保留原异常 */ }
      }
      throw new TunnelError('CONFIG_WRITE_FAILED', `保存隧道配置失败: ${error.message}`, 500);
    }
    this._public = clone(nextPublic);
    this._private = clone(nextPrivate);
  }
}

module.exports = { TunnelStore, writeAtomic };
