'use strict';

const crypto = require('crypto');

const TARGETS = Object.freeze([
  { id: 'workbuddy', name: 'WorkBuddy2API', kind: 'api', upstreamPort: 7863, guardPort: 17901 },
  { id: 'codearts', name: 'CodeArts2API', kind: 'api', upstreamPort: 7866, guardPort: 17902 },
  { id: 'loomy', name: 'Loomy2API', kind: 'api', upstreamPort: 17990, guardPort: 17903 },
  { id: 'lingxi', name: 'Lingxi2API', kind: 'api', upstreamPort: 6789, guardPort: 17904 },
  { id: 'magpie', name: 'Magpie 统一 API', kind: 'api', upstreamPort: 3425, guardPort: 17905 },
  { id: 'manager', name: 'Wanneng2API 管理台', kind: 'manager', upstreamPort: 17800, guardPort: 17906 },
].map((item) => Object.freeze(item)));

const TARGET_MAP = new Map(TARGETS.map((item) => [item.id, item]));
const MODES = new Set(['quick', 'named']);

class TunnelError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function targetOf(id) {
  const target = TARGET_MAP.get(String(id || ''));
  if (!target) throw new TunnelError('UNKNOWN_TARGET', `未知外网目标: ${id}`, 404);
  return target;
}

function defaultTargetConfig(id) {
  const target = targetOf(id);
  return {
    mode: 'quick',
    autoStart: false,
    publicUrl: '',
    guardPort: target.guardPort,
    updatedAt: 0,
  };
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!MODES.has(mode)) throw new TunnelError('INVALID_MODE', '隧道模式只能是 quick 或 named');
  return mode;
}

function normalizeGuardPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TunnelError('INVALID_GUARD_PORT', '本机入口端口必须是 1024-65535 的整数');
  }
  return port;
}

function normalizePublicUrl(value, { named = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (named) throw new TunnelError('PUBLIC_URL_REQUIRED', 'Named 模式必须填写公网域名');
    return '';
  }
  let url;
  try { url = new URL(raw); } catch {
    throw new TunnelError('INVALID_PUBLIC_URL', '公网地址必须是有效的 HTTPS Origin');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
    || path || url.search || url.hash) {
    throw new TunnelError('INVALID_PUBLIC_URL', '公网地址只能是 https://域名，不能带路径、账号、查询或片段');
  }
  if (named && url.hostname.toLowerCase().endsWith('.trycloudflare.com')) {
    throw new TunnelError('INVALID_PUBLIC_URL', 'Named 模式不能使用 trycloudflare.com 临时域名');
  }
  return url.origin;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (!token) throw new TunnelError('TOKEN_REQUIRED', 'Named 模式必须填写 Tunnel Token');
  if (token.length > 16384 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new TunnelError('INVALID_TOKEN', 'Tunnel Token 格式无效');
  }
  return token;
}

function tokenFingerprint(value) {
  return crypto.createHash('sha256').update(normalizeToken(value)).digest('hex');
}

function parseNamedTokenInfo(value) {
  const token = normalizeToken(value);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) {
    throw new TunnelError('INVALID_TOKEN', 'Tunnel Token 不是有效的 base64url JSON');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch {
    throw new TunnelError('INVALID_TOKEN', 'Tunnel Token 不是有效的 base64url JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || ['a', 't', 's'].some((key) => typeof payload[key] !== 'string' || !payload[key].trim())) {
    throw new TunnelError('INVALID_TOKEN', 'Tunnel Token 缺少有效的 a/t/s 字段');
  }
  return { tunnelId: payload.t };
}

function normalizeTargetConfig(id, value) {
  const base = defaultTargetConfig(id);
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = normalizeMode(input.mode || base.mode);
  return {
    mode,
    autoStart: input.autoStart === true,
    publicUrl: normalizePublicUrl(input.publicUrl || '', { named: false }),
    guardPort: normalizeGuardPort(input.guardPort || base.guardPort),
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : 0,
  };
}

function validateUnique(configs, secrets) {
  const ports = new Map();
  const urls = new Map();
  const tokens = new Map();
  for (const target of TARGETS) {
    const config = configs[target.id];
    if (!config) continue;
    if (ports.has(config.guardPort)) {
      throw new TunnelError('DUPLICATE_GUARD_PORT', `${target.name} 与 ${targetOf(ports.get(config.guardPort)).name} 的本机入口端口重复`, 409);
    }
    ports.set(config.guardPort, target.id);
    if (config.mode !== 'named') continue;
    if (config.publicUrl) {
      const key = config.publicUrl.toLowerCase();
      if (urls.has(key)) {
        throw new TunnelError('DUPLICATE_PUBLIC_URL', `${target.name} 与 ${targetOf(urls.get(key)).name} 的公网域名重复`, 409);
      }
      urls.set(key, target.id);
    }
    const token = String(secrets.tokens[target.id] || '');
    if (token) {
      if (tokens.has(token)) {
        throw new TunnelError('DUPLICATE_TOKEN', `${target.name} 与 ${targetOf(tokens.get(token)).name} 不能共用 Named Tunnel Token`, 409);
      }
      tokens.set(token, target.id);
    }
  }
}

function startConfig(id, config, secrets) {
  const normalized = normalizeTargetConfig(id, config);
  if (normalized.mode === 'quick') return { ...normalized, token: '' };
  const token = normalizeToken(secrets.tokens[id]);
  const info = parseNamedTokenInfo(token);
  const verification = secrets.verification && secrets.verification[id];
  if (!verification || !(verification.verifiedAt > 0) || verification.tunnelId !== info.tunnelId
    || verification.fingerprint !== tokenFingerprint(token)) {
    throw new TunnelError('TOKEN_VERIFICATION_REQUIRED', '请先验证 Tunnel Token，再配置 Public Hostname 并启动', 409);
  }
  return {
    ...normalized,
    publicUrl: normalizePublicUrl(normalized.publicUrl, { named: true }),
    token,
  };
}

module.exports = {
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
};
