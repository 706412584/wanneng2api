'use strict';
/**
 * gateway-panel.js — 自研网关的原生管理适配层
 *
 * 四个自研网关（WorkBuddy / CodeArts / Loomy / Lingxi）各自有一套管理 HTTP 接口，
 * 本模块把它们收敛成同一份只读视图 + 一张受限动作表，供 Manager API 与前端抽屉使用。
 *
 * 边界（与 PluginPanel 同一套约定）：
 *  - 只允许访问本机固定目标（127.0.0.1 / localhost），不接受调用方指定 URL 或路径；
 *  - 动作名走白名单，参数逐个校验后再组装；
 *  - 凭据（CodeArts admin_key / Lingxi & Loomy api_key）只在这里读取，绝不返回前端；
 *  - 超时与响应大小有上限；上游错误文本先脱敏再外传。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * 各网关支持的能力，前端据此显示分区。
 *
 * 用 Object.create(null) 而不是对象字面量：普通对象的原型链会让
 * CAPS['constructor'] / CAPS['toString'] 命中原型方法（真值），
 * 从而把「平台是否支持」的判断绕过。null 原型没有继承，查不到就是 undefined。
 */
const CAPS = Object.assign(Object.create(null), {
  workbuddy: ['accounts', 'groups', 'stats', 'logs', 'schedule', 'checkin'],
  codearts: ['accounts', 'stats', 'logs', 'credits', 'checkin'],
  loomy: ['accounts', 'stats', 'points', 'logs', 'checkin'],
  lingxi: ['accounts', 'stats', 'usage', 'logs', 'checkin'],
});

// ── 工具 ──

function text(v) { return typeof v === 'string' ? v : ''; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function bool(v) { return !!v; }
function arr(v) { return Array.isArray(v) ? v : []; }

/** Unix 秒 → ISO；已是字符串则原样透传（各家口径不一） */
function iso(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && v > 0) return new Date(v * 1000).toISOString();
  return '';
}

/**
 * 从网关的错误响应体里取出可读的原因：各家都返回 {"error":"…"}，
 * 少数写成 {"message":"…"} 或纯文本。取不到就返回空串。
 */
function _errorMessage(bodyText) {
  const raw = text(bodyText).trim();
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return text(obj.error) || text(obj.message) || '';
    }
  } catch { /* 非 JSON：按纯文本处理 */ }
  return raw;
}

/** 上游错误文本脱敏（与 PluginPanel._redact 同规则） */
function redact(value) {
  return String(value || '')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[已隐藏]')
    .replace(/([?&](?:k|key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, '$1[已隐藏]')
    .slice(0, 300);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 把各家五花八门的倍率写法归一成数字，解析不出来给 null。
 *
 * 实测四家的格式：
 *   WorkBuddy  credits:       "x0.29"     （x 在前）
 *   CodeArts   ratio_display: "0.18x"     （x 在后）
 *   Lingxi     credits:       "～0.12x"   （全角波浪号前缀，表示约数）
 *   Loomy      无独立字段，倍率在模型 name 的括号里："(x0.0)" / "（x3.3）"
 *
 * 返回 null 表示「这家没提供倍率」，与 0 有本质区别（0 是免费），
 * 调用方必须据此显示「—」而不是「0x」。
 */
function parseRatio(v) {
  const s = text(v).trim();
  if (!s) return null;
  // 同时接受半角/全角括号包裹；剥离 x 前缀/后缀与约数标记
  const m = /^[（(]?\s*[～~]?\s*x?\s*([0-9]*\.?[0-9]+)\s*[xX]?\s*[）)]?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * WorkBuddy 的 tags 里混着展示用的徽标："badge:限时免费:#FF0000"。
 * 抽成 {text,color} 供前端直接渲染，其余标签（craft / text-to-video）忽略。
 */
function badgeFromTags(tags) {
  for (const t of arr(tags)) {
    const m = /^badge:([^:]*)(?::(#[0-9a-fA-F]{3,8}))?$/.exec(text(t));
    if (m && m[1]) return { text: m[1], color: m[2] || '' };
  }
  return null;
}

/** 从模型名里抽倍率，如 "Spark-X2.6 正式版(限时免费)(x0.0)" → 0；没有则 null */
function ratioFromName(name) {
  const s = text(name);
  if (!s) return null;
  // 取**最后一个**括号片段，避免「(限时免费)」这类前缀干扰
  const all = [...s.matchAll(/[（(]\s*[～~]?\s*x\s*([0-9]*\.?[0-9]+)\s*[）)]/gi)];
  if (!all.length) return null;
  const n = Number(all[all.length - 1][1]);
  return Number.isFinite(n) ? n : null;
}

function expandPath(p) {
  const raw = String(p || '');
  const appData = process.env.APPDATA || '';
  return raw.replace(/%([A-Za-z_]+)%/g, (m, name) => process.env[name] || appData || m);
}

/**
 * 统一的网关管理适配器。
 *
 * @param {object} opts
 * @param {Function} opts.getPlatform  (id) => platforms.json 里的平台条目
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 */
class GatewayPanel {
  constructor({ getPlatform, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024 }) {
    this.getPlatform = getPlatform;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  /** 校验平台 id 属于支持的四家之一并返回其配置；否则抛出 */
  _platform(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('平台标识无效');
    const p = this.getPlatform(id);
    if (!p) throw new Error('未知平台');
    if (!CAPS[id]) throw new Error('该平台不支持原生管理面板');
    if (p.enabled === false) throw new Error('该平台已被禁用');
    const port = Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('平台端口配置无效');
    return { ...p, id, port };
  }

  /** 本机目标地址 */
  _origin(platform) {
    return `http://127.0.0.1:${platform.port}`;
  }

  /**
   * 单次 HTTP 请求（仅本机 http、固定 method、响应限额）。
   * @returns {Promise<{status:number, headers:object, text:string}>}
   */
  _http(url, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      let size = 0;
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      const req = http.request(url, {
        method,
        agent: false,
        timeout: timeoutMs || this.timeoutMs,
        headers: {
          Accept: 'application/json',
          ...headers,
          ...(payload === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > this.maxBytes) { res.destroy(); fail(new Error('网关管理响应过大')); }
          else chunks.push(chunk);
        });
        res.on('error', () => fail(new Error('网关管理响应中断')));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('timeout', () => { req.destroy(); fail(new Error('网关管理请求超时')); });
      req.on('error', (e) => fail(new Error(e.code === 'ECONNREFUSED' ? '无法连接该网关（未在运行？）' : '网关管理请求失败')));
      req.end(payload);
    });
  }

  /** 组装 URL 并确保目标仍是本机 origin（防止参数拼出外部地址） */
  _url(platform, pathAndQuery, query) {
    const origin = this._origin(platform);
    let url;
    try { url = new URL(pathAndQuery, origin); } catch { throw new Error('网关管理路径无效'); }
    if (url.origin !== origin) throw new Error('网关管理仅允许访问本机目标');
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }

  /**
   * 读 JSON。非 2xx 时不透传正文（可能含凭据），只给出状态码与稳定文案。
   */
  async _json(platform, pathAndQuery, { method = 'GET', headers = {}, body, query } = {}) {
    const url = this._url(platform, pathAndQuery, query);
    const r = await this._http(url, { method, headers, body });
    if (r.status === 401 || r.status === 403) throw new Error('网关管理鉴权失败，请检查其管理密钥配置');
    if (r.status === 404) throw new Error('当前网关版本不支持该管理接口');
    if (r.status < 200 || r.status >= 300) {
      // 网关的拒绝理由（如 WorkBuddy 的 409「签到 正在执行中」）是用户唯一能
      // 据此行动的信息，不能只留一个状态码。正文先脱敏再截断；解析不出来
      // 或内容过长就退回纯状态码，避免把 HTML/HTML 错误页整段透给前端。
      const reason = redact(text(_errorMessage(r.text)));
      throw new Error(reason
        ? `网关未能完成该操作（HTTP ${r.status}）：${reason}`
        : `网关未能完成该操作（HTTP ${r.status}）`);
    }
    if (!r.text || !r.text.trim()) return {};
    try { return JSON.parse(r.text); } catch { throw new Error('网关管理接口返回了不兼容的数据'); }
  }

  // ── 各家凭据 ──

  /**
   * CodeArts / Lingxi 的管理密钥：优先取平台配置的 run.env（若显式给出），
   * 否则读网关自己工作目录里的 config.json。返回值只在后台使用。
   */
  _adminKey(platform, fileName, field) {
    const env = platform.run && platform.run.env;
    const fromEnv = env && env[field];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
    if (!platform.workDir) return '';
    const file = path.join(expandPath(platform.workDir), fileName);
    const cfg = readJson(file);
    return cfg && typeof cfg[field] === 'string' ? cfg[field] : '';
  }

  _codeartsKey(platform) { return this._adminKey(platform, 'config.json', 'admin_key'); }
  _lingxiKey(platform) { return this._adminKey(platform, 'config.json', 'api_key'); }

  /** Loomy 的 api_keys 是数组，取第一个（面板写入也用它） */
  _loomyKey(platform) {
    const env = platform.run && platform.run.env;
    if (env && typeof env.API_KEY === 'string' && env.API_KEY.trim()) return env.API_KEY.trim();
    if (!platform.workDir) return '';
    const cfg = readJson(path.join(expandPath(platform.workDir), 'config.json'));
    const keys = arr(cfg && cfg.api_keys).filter((k) => typeof k === 'string' && k);
    return keys[0] || '';
  }

  /**
 * 给请求附上鉴权头（各家协议不同）。
 *
 * key 为空时**不附加头**，让请求照常发出：三家网关在未配置密钥时
 * 都对本机放行（Loomy 的 api_keys 实测为空数组，CodeArts 的 admin_key
 * 为空时回退 api_key 且两者都空才强制 401）。这里如果改成「空 key 就抛错」，
 * 会把一个正常工作的免鉴权网关判定成不可用（实测 Loomy 会整页报错）。
 * 真被 401 拒绝时，_json 会给「鉴权失败」的明确提示。
 */
  _authHeaders(platform) {
    if (platform.id === 'workbuddy') return {}; // /__admin/* 只在本机免鉴权
    const read = {
      codearts: this._codeartsKey,
      lingxi: this._lingxiKey,
      loomy: this._loomyKey,
    }[platform.id];
    if (!read) return {};
    const key = read.call(this, platform);
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /**
   * 该网关在本机的安装位置，供界面直接显示（用户要能一眼找到它装在哪）。
   * workDir 展开 %APPDATA% 等占位符；入口按类型给出可执行文件或模块名。
   */
  _installInfo(platform) {
    const workDir = platform.workDir ? expandPath(platform.workDir) : '';
    const run = platform.run && typeof platform.run === 'object' ? platform.run : {};
    const binary = text(run.binary);
    const module = text(run.module);
    let entry = binary;
    if (!entry && module) entry = `python -m ${module}`;
    return { workDir, entry, type: text(platform.type) };
  }

  // ── 读取：统一视图 ──

  async detail(id) {
    const platform = this._platform(id);
    const caps = CAPS[id];
    const base = {
      id, name: text(platform.name) || id, port: platform.port,
      baseUrl: this._origin(platform), capabilities: caps,
      install: this._installInfo(platform),
    };
    const load = async (fn, fallback) => { try { return await fn(); } catch (e) { return { ...fallback, error: redact(e.message) }; } };
    if (id === 'workbuddy') {
      const [accounts, stats, groups, schedule] = await Promise.all([
        load(() => this._wbAccounts(platform), { accounts: [] }),
        load(() => this._wbStats(platform), {}),
        load(() => this._wbGroups(platform), { groups: {}, names: [] }),
        load(() => this._wbSchedule(platform), { tasks: [] }),
      ]);
      return { ...base, accounts, stats, groups, schedule };
    }
    if (id === 'codearts') {
      const [accounts, models] = await Promise.all([
        load(() => this._caOverview(platform), { accounts: [] }),
        load(() => this._caModels(platform), { models: [] }),
      ]);
      return { ...base, accounts, models };
    }
    if (id === 'loomy') {
      const [state, points] = await Promise.all([
        load(() => this._loomyState(platform), { accounts: [], totals: {} }),
        load(() => this._loomyPoints(platform), {}),
      ]);
      return { ...base, accounts: state, points };
    }
    // lingxi
    const [overview, usage] = await Promise.all([
      load(() => this._lxOverview(platform), { accounts: [] }),
      load(() => this._lxUsage(platform), {}),
    ]);
    return { ...base, accounts: overview, usage };
  }

  async logs(id, { lines = 200 } = {}) {
    const platform = this._platform(id);
    // 尊重调用方给的条数（下限 1）；0/NaN 回落到默认 200
    const limit = Math.min(Math.max(Number(lines) || 200, 1), 1000);
    if (id === 'workbuddy') {
      const r = await this._json(platform, '/__admin/logs');
      return { lines: arr(r.lines).slice(-limit).map((l) => text(l)) };
    }
    if (id === 'codearts') {
      const r = await this._json(platform, '/admin/api/logs', { headers: this._authHeaders(platform), query: { limit } });
      // 内核给的是 {entries:[{ts,ch,text}]}，不是纯字符串行
      const rows = arr(r.entries || r.logs || r.lines);
      return {
        lines: rows.slice(-limit).map((e) => (typeof e === 'string' ? e
          : `${text(e.ts)} [${text(e.ch)}] ${redact(e.text || '')}`.trim())),
      };
    }
    if (id === 'loomy') {
      const r = await this._json(platform, '/api/panel/logs', { headers: this._authHeaders(platform), query: { limit } });
      return { lines: arr(r.logs || r.lines).slice(-limit).map((l) => typeof l === 'string' ? l : redact(l.message || '')) };
    }
    const r = await this._json(platform, '/panel/api/request_logs', { headers: this._authHeaders(platform), query: { limit } });
    return { lines: arr(r.entries).slice(-limit).map((e) => `${text(e.time)} ${text(e.method)} ${text(e.path)} ${e.status ?? ''} ${text(e.account)} ${text(e.model)} ${text(e.outcome)}`.trim()) };
  }

  // ── WorkBuddy ──

  async _wbAccounts(platform) {
    const r = await this._json(platform, '/__admin/accounts');
    const accounts = arr(r.accounts).filter((a) => a && typeof a.uid === 'string').map((a) => {
      const calls = arr(a.calls);
      const lastCall = calls[0] || null;
      return {
        id: a.uid,
        file: text(a.file),
        name: text(a.nickname) || text(a.uid).slice(0, 8),
        region: text(a.region),
        domain: text(a.domain),
        enabled: !bool(a.disabled),
        disabledReason: redact(a.disabledReason || ''),
        inPool: bool(a.inPool),
        expired: bool(a.expired),
        expiresAt: iso(a.expiresAt),
        createdAt: iso(a.createdAt),
        lastSuccess: text(a.lastSuccess),
        // 不返回 tokenHint：它是 token 的前 6 位，属于凭据片段；
        // 前端只需要「有没有登录」，用 inPool/expired 判断即可。
        // 最近一次调用结果，供前端显示「这个号最近发生了什么」
        lastCall: lastCall ? {
          ok: lastCall.ok !== false,
          at: text(lastCall.at || lastCall.time || ''),
          status: num(lastCall.status ?? lastCall.code),
          error: redact(lastCall.error || lastCall.reason || ''),
        } : null,
      };
    });
    return { accounts, authDir: text(r.authDir) };
  }

  async _wbStats(platform) {
    const r = await this._json(platform, '/__admin/stats');
    const statusCounts = {};
    for (const row of arr(r.statusCounts)) {
      const key = String(row && (row.status ?? row.code ?? ''));
      if (key) statusCounts[key] = num(row.count) ?? 0;
    }
    return {
      totalRequests: num(r.totalRequests),
      ok: num(r.ok),
      errors: num(r.errors),
      successRate: num(r.successRate),
      tokensTotal: num(r.tokensTotal),
      firstTs: text(r.firstTs),
      lastTs: text(r.lastTs),
      windowHours: num(r.windowHours),
      windowNote: text(r.windowNote),
      statusCounts,
      byAccount: arr(r.byAccount).map((a) => ({
        key: text(a.key), requests: num(a.requests), ok: num(a.ok), errors: num(a.errors),
        tokens: num(a.tokens), successRate: num(a.successRate),
        avgTtfbMs: num(a.avgTtfbMs), avgTokps: num(a.avgTokps),
      })),
      byModel: arr(r.byModel).map((m) => ({
        key: text(m.key), requests: num(m.requests), ok: num(m.ok), errors: num(m.errors),
        tokens: num(m.tokens), successRate: num(m.successRate),
      })),
    };
  }

  async _wbGroups(platform) {
    const r = await this._json(platform, '/__admin/groups');
    const groups = {};
    if (r && r.groups && typeof r.groups === 'object') {
      for (const [uid, name] of Object.entries(r.groups)) groups[text(uid)] = text(name);
    }
    return {
      available: bool(r.available),
      names: arr(r.names).map((n) => text(n)),
      emptyNames: arr(r.emptyNames).map((n) => text(n)),
      groups,
    };
  }

  async _wbSchedule(platform) {
    const r = await this._json(platform, '/__admin/schedule');
    return {
      now: text(r.now),
      tasks: arr(r.tasks).filter((t) => t && typeof t.key === 'string').map((t) => ({
        key: t.key, label: text(t.label), enabled: bool(t.enabled), quiet: bool(t.quiet),
        hours: arr(t.hours).map((h) => num(h)).filter((h) => h !== null),
        nextRun: text(t.nextRun || t.next || ''), lastRun: text(t.lastRun || ''),
        lastResult: t.lastResult === undefined ? '' : redact(JSON.stringify(t.lastResult)),
        running: bool(t.running), note: text(t.note),
      })),
    };
  }

  // ── CodeArts ──

  async _caOverview(platform) {
    const r = await this._json(platform, '/admin/api/overview', { headers: this._authHeaders(platform) });
    const stats = r.stats && typeof r.stats === 'object' ? r.stats : {};
    const accounts = arr(r.accounts).filter((a) => a && typeof a.uid === 'string').map((a) => {
      const cb = a.credit_balance && typeof a.credit_balance === 'object' ? a.credit_balance : {};
      return {
        id: a.uid,
        name: text(a.nickname) || text(a.user_name) || text(a.uid).slice(0, 8),
        user: text(a.user_name),
        note: redact(a.note || ''),
        disabled: bool(a.disabled),
        disabledReason: redact(a.reason || ''),
        cooling: bool(a.cooling),
        // 与前端「已启用」语义一致：禁用 = enabled false
        enabled: !bool(a.disabled),
        credits: num(a.credits),
        creditTotal: num(cb.total),
        expiresAt: text(a.expires_at),
        tokenRemaining: text(a.token_remaining),
        refreshable: bool(a.refreshable),
        credentialType: text(a.credential_type),
        lastError: redact(a.last_error || ''),
        errCount: num(a.err_count) ?? 0,
        defaultModel: text(a.default_model),
        checkinDone: bool(a.checkin_done),
        lastCheckinDay: text(a.last_checkin_day),
        checkin: a.checkin === undefined ? null : (a.checkin && typeof a.checkin === 'object'
          ? { day: text(a.checkin.day), result: redact(a.checkin.result || a.checkin.message || '') } : null),
        activeConcurrent: num(a.active_concurrent),
        maxConcurrent: num(a.max_concurrent),
        balanceUpdatedAt: text(a.balance_updated_at),
      };
    });
    return {
      accounts,
      stats: {
        total: num(stats.total) ?? accounts.length,
        healthy: num(stats.healthy) ?? 0,
        cooling: num(stats.cooling) ?? 0,
        disabled: num(stats.disabled) ?? 0,
        sticky: num(stats.sticky) ?? 0,
        credits: num(stats.credits),
      },
      region: text(r.region),
      service: text(r.service),
      version: text(r.version),
      uptimeSec: num(r.uptime_sec),
      startedAt: text(r.started_at),
      schedule: r.schedule && typeof r.schedule === 'object' ? r.schedule : {},
    };
  }

  async _caModels(platform) {
    const r = await this._json(platform, '/admin/api/models', { headers: this._authHeaders(platform) });
    return {
      models: arr(r.data).filter((m) => m && typeof m.id === 'string').map((m) => ({
        id: m.id,
        // 列表里是 model_name（人话），model_desc 是说明；早先只读 name 会得到空串
        name: text(m.model_name) || text(m.name) || m.id,
        context: num(m.context_length),
        ratio: parseRatio(m.ratio_display),
        ratioText: text(m.ratio_display),
        tag: text(m.model_tag),
        notice: text(m.notice),
      })),
    };
  }

  // ── 模型目录（四家统一形状，供「模型列表」页与倍率聚合使用）──

  /**
   * WorkBuddy：/v1/models 需要 Bearer，密钥在 config.json 的 api_keys（对象数组，
   * 取第一个的 key）。字段 credits 就是倍率（"x0.29"）。没有 video 模型倍率。
   */
  async _wbModels(platform) {
    const cfg = platform.workDir
      ? readJson(path.join(expandPath(platform.workDir), 'config.json')) : null;
    const list = arr(cfg && cfg.api_keys);
    const first = list[0];
    const key = typeof first === 'string' ? first : text(first && first.key);
    const r = await this._json(platform, '/v1/models', { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    return {
      models: arr(r.data).filter((m) => m && typeof m.id === 'string').map((m) => ({
        id: m.id,
        name: text(m.name) || m.id,
        context: num(m.context_length),
        // credits 缺席 = 这家没标倍率（如 auto / 视频模型），不是 0
        ratio: parseRatio(m.credits),
        ratioText: text(m.credits),
        badge: badgeFromTags(m.tags),
      })),
    };
  }

  /** Loomy：/v1/models 的倍率藏在 name 的括号里，id 干净 */
  async _loomyModels(platform) {
    const r = await this._json(platform, '/v1/models', { headers: this._authHeaders(platform) });
    return {
      models: arr(r.data).filter((m) => m && typeof m.id === 'string').map((m) => ({
        id: m.id,
        name: text(m.name) || m.id,
        context: num(m.context_length),
        ratio: ratioFromName(m.name),
        ratioText: '',
      })),
    };
  }

  /** Lingxi：/panel/api/models 的 credits 是结构化倍率（"～0.12x"，约数） */
  async _lxModels(platform) {
    const r = await this._json(platform, '/panel/api/models', { headers: this._authHeaders(platform) });
    return {
      models: arr(r.models).filter((m) => m && typeof m.id === 'string').map((m) => ({
        id: m.id,
        name: text(m.name) || m.id,
        context: num(m.context_length),
        ratio: parseRatio(m.credits),
        ratioText: text(m.credits),
        default: bool(m.is_default),
      })),
    };
  }

  /**
   * 统一模型目录：只返回该平台已启用的模型（与 magpie 里 `on` 的口径对齐）。
   * 由 API 层聚合成「模型 × 各平台倍率」。
   */
  async models(id) {
    const platform = this._platform(id);
    const read = {
      workbuddy: this._wbModels,
      codearts: this._caModels,
      loomy: this._loomyModels,
      lingxi: this._lxModels,
    }[id];
    const r = await read.call(this, platform);
    // 去重：同名 id 只留第一条（上游偶有重复条目）
    const seen = new Set();
    const models = [];
    for (const m of r.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    return { platform: id, models };
  }

  // ── Loomy ──

  async _loomyState(platform) {
    const r = await this._json(platform, '/api/panel/state', { headers: this._authHeaders(platform) });
    const totals = r.totals && typeof r.totals === 'object' ? r.totals : {};
    const accounts = arr(r.accounts).filter((a) => a && typeof a.name === 'string').map((a) => ({
      id: a.name,
      name: text(a.name),
      masked: text(a.loginid_masked),
      enabled: a.enabled !== false,
      available: num(a.available),
      balance: num(a.balance),
      dailyBalance: num(a.daily_balance),
      pointsUsed: num(a.points_used),
      requests: num(a.requests),
      failures: num(a.failures),
      inCooldown: bool(a.in_cooldown),
      cooldownLeft: num(a.cooldown_seconds_left),
      banned: bool(a.banned),
      hasPassword: bool(a.has_password),
      sessionDaysLeft: num(a.session_days_left),
      expireAt: iso(a.expire_at),
      quotaUpdatedAt: iso(a.quota_updated_at),
      lastError: redact(a.last_error || ''),
      activated: bool(a.activated),
      ledgerTotal: num(a.ledger_total),
    }));
    return {
      accounts,
      totals: {
        accounts: num(totals.accounts) ?? accounts.length,
        usable: num(totals.usable) ?? null,
        available: num(totals.available) ?? null,
        requests: num(totals.requests) ?? null,
        pointsUsed: num(totals.points_used) ?? null,
        tokens: num(totals.tokens) ?? null,
        failures: num(totals.failures) ?? null,
        // Loomy 面板里的「可用积分 Available」就是 totals.available（每个号跨
        // 会话取较大值再求和）。UI 的「总积分」格读 credits，不给这一项时
        // 那个格子只会显示「—」。逐号不再补 credits：账号行已经有「可用」，
        // 同一个数出现两次反而费解。
        credits: num(totals.available),
        // 「冷却中」格：网关只给逐号的 in_cooldown 标志、没有汇总，这里自己数。
        cooling: accounts.filter((a) => a.inCooldown).length,
      },
      now: num(r.now),
    };
  }

  async _loomyPoints(platform) {
    const r = await this._json(platform, '/api/panel/points', { headers: this._authHeaders(platform) });
    const o = r.overview && typeof r.overview === 'object' ? r.overview : {};
    const ledger = r.ledger && typeof r.ledger === 'object' ? r.ledger : {};
    return {
      account: text(r.account),
      dailyQuota: num(o.daily_quota),
      dailyConsumed: num(o.daily_consumed),
      dailyBalance: num(o.daily_balance),
      dailyCycleDate: text(o.daily_cycle_date),
      permanentBalance: num(o.permanent_balance),
      ledgerTotal: num(ledger.total),
      recent: arr(ledger.rows).slice(0, 20).map((x) => ({
        at: iso(x.created_at), model: text(x.model), direction: text(x.direction),
        points: num(x.points), description: redact(x.description || ''),
        source: text(x.source), balanceAfter: num(x.balance_after), cycleDate: text(x.cycle_date),
      })),
    };
  }

  // ── Lingxi ──

  async _lxOverview(platform) {
    const r = await this._json(platform, '/panel/api/overview', { headers: this._authHeaders(platform) });
    const accounts = arr(r.accounts).filter((a) => a && typeof a.uid === 'string').map((a) => ({
      id: a.uid,
      name: text(a.nickname) || text(a.uid).slice(0, 8),
      realm: text(a.realm),
      enterprise: bool(a.enterprise),
      credits: num(a.credits),
      creditsTotal: num(a.credits_total),
      creditsExpiring: num(a.credits_expiring),
      cooling: bool(a.cooling),
      coolKind: text(a.cool_kind),
      coolRemaining: num(a.cool_remaining_sec),
      disabled: bool(a.disabled),
      disabledReason: redact(a.disabled_reason || ''),
      enabled: !bool(a.disabled),
      paused: bool(a.paused),
      expiryBuckets: arr(a.credits_expiry_buckets).map((b) => ({
        date: text(b.date), expiresAt: text(b.expires_at), remain: num(b.remain),
      })),
      successCount: num(a.success_count) ?? 0,
      errTotal: num(a.err_total) ?? 0,
      lastSuccess: text(a.last_success),
      lastError: text(a.last_err),
      checkinDone: bool(a.checkin_done),
      tokenUsage: a.token_usage && typeof a.token_usage === 'object' ? {
        prompt: num(a.token_usage.prompt), completion: num(a.token_usage.completion),
        total: num(a.token_usage.total),
      } : null,
    }));
    return {
      accounts,
      total: num(r.total) ?? accounts.length,
      healthy: num(r.healthy) ?? 0,
      cooling: num(r.cooling) ?? 0,
      disabled: num(r.disabled) ?? 0,
      paused: num(r.paused) ?? 0,
      inFlightFull: num(r.in_flight_full) ?? 0,
      stickySessions: num(r.sticky_sessions) ?? 0,
      authRequired: bool(r.auth_required),
      version: text(r.version),
      uptimeSec: num(r.uptime_sec),
      balanceRefreshedAt: text(r.balance_refreshed_at),
      balanceRefreshSec: num(r.balance_refresh_sec),
    };
  }

  async _lxUsage(platform) {
    const r = await this._json(platform, '/panel/api/usage', { headers: this._authHeaders(platform) });
    const t = r.totals && typeof r.totals === 'object' ? r.totals : {};
    return {
      totals: {
        requests: num(t.requests), errors: num(t.errors),
        promptTokens: num(t.prompt_tokens), completionTokens: num(t.completion_tokens),
        totalTokens: num(t.total_tokens), credits: num(t.credits),
        avgLatencyMs: num(t.avg_latency_ms), avgTokps: num(t.avg_tokens_per_second),
      },
      byAccount: arr(r.by_account).map((a) => ({
        key: text(a.key || a.account), requests: num(a.requests), errors: num(a.errors),
        tokens: num(a.total_tokens), credits: num(a.credits),
      })),
      byModel: arr(r.by_model).map((m) => ({
        key: text(m.key || m.model), requests: num(m.requests), errors: num(m.errors),
        tokens: num(m.total_tokens), credits: num(m.credits),
      })),
      generated: text(r.generated),
    };
  }

  // ── 动作（白名单 + 逐家校验） ──

  /**
   * @param {string} id 平台 id
   * @param {string} action 动作名
   * @param {object} body 参数
   */
  async action(id, action, body = {}) {
    const platform = this._platform(id);
    if (typeof action !== 'string' || !action) throw new Error('缺少管理动作');
    // 必须用 hasOwnProperty 校验：ACTIONS[id] 是普通对象，
    // ACTIONS['workbuddy']['constructor'] 命中的是 Object.prototype.constructor。
    // 直接取会把 Object 构造器当 handler 调，返回值是平台配置对象本身
    // —— 其中含 CodeArts 的 run.env.admin_key，等于把管理密钥交给前端。
    // 'toString' / 'valueOf' 同样能穿过原型链，必须一并挡掉。
    const table = Object.prototype.hasOwnProperty.call(ACTIONS, id) ? ACTIONS[id] : null;
    const handler = table && Object.prototype.hasOwnProperty.call(table, action) ? table[action] : null;
    if (typeof handler !== 'function') throw new Error('不支持的网关管理动作');
    return handler.call(this, platform, body);
  }

  // 单个账号的断言：只按 uid/name 定位，前端不能塞任意东西。
  // 有些网关（Lingxi）把 uid 放进 URL path：encodeURIComponent 不会编码 ".."
  // 和 "."，而 URL 构造时会把它们当作路径段消解
  //   '/panel/api/accounts/../disable' → '/panel/api/disable'
  // 于是「停用账号」会打到别的端点上。这类值必须在入口直接拒绝。
  _uid(body, field = 'id') {
    const v = body[field];
    if (typeof v !== 'string' || !v || v.length > 200) throw new Error('账号标识无效');
    if (v === '.' || v === '..' || /[.．]{2}|[/\\\x00-\x1f]/.test(v)) throw new Error('账号标识无效');
    return v;
  }
}

// ── 各家动作表 ──
// 每个动作都只接受固定参数，并在后台把「平台 id → 真正的容器 id」补齐。

const ACTIONS = {
  workbuddy: {
    async 'account-toggle'(platform, body) {
      const uid = this._uid(body, 'id');
      const disabled = body.enabled === false || body.disabled === true;
      const r = await this._json(platform, '/__admin/accounts/toggle', {
        method: 'POST', body: { uid, disabled },
      });
      return { ok: true, id: uid, enabled: !disabled, message: redact(r.message || '') };
    },
    async 'account-test'(platform, body) {
      const uid = this._uid(body, 'id');
      // 只测账号连通性，固定用便宜模型，避免用户在面板上单击一次就烧掉高价额度
      const r = await this._json(platform, '/__admin/accounts/test', {
        method: 'POST', body: { uid, model: 'deepseek-v4.1-flash' },
      });
      return {
        ok: r.ok !== false,
        id: uid,
        status: num(r.status) ?? null,
        latencyMs: num(r.latencyMs ?? r.latency_ms) ?? null,
        message: redact(r.message || r.error || ''),
      };
    },
    // 动作名与前端统一为 account-remove：早先前端固定调 account-remove，
    // 而后端这里只叫 account-delete，点「移除」必然报「不支持的动作」。
    async 'account-remove'(platform, body) {
      const uid = this._uid(body, 'id');
      // 网关按凭证**文件名**删除，而不是 uid；前端只知道 uid。
      // 文件名由后台从账号列表反查，不由调用方提供（避免塞任意路径）。
      const list = await this._json(platform, '/__admin/accounts');
      const row = arr(list.accounts).find((a) => a && a.uid === uid);
      const file = row && row.file;
      if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+\.json$/.test(file)) {
        throw new Error('未找到该账号的凭证文件，无法移除');
      }
      await this._json(platform, '/__admin/accounts/delete', { method: 'POST', body: { file } });
      return { ok: true, id: uid, removed: true };
    },
    async checkin(platform, body) {
      // WorkBuddy 的签到是**排程任务**：一次跑所有 global 账号，不能对单个 uid 下指令。
      // 任务名只能取当前排程里真实存在的 key，防止前端传入任意任务。
      const schedule = await this._json(platform, '/__admin/schedule');
      const known = arr(schedule.tasks).map((t) => text(t.key)).filter(Boolean);
      const task = typeof body.task === 'string' && body.task ? body.task : 'checkin';
      if (!known.includes(task)) throw new Error('该排程任务不存在');
      const r = await this._json(platform, '/__admin/schedule/run', { method: 'POST', body: { task } });
      return { ok: true, task, started: true, message: redact(r.message || '') };
    },
    async 'group-set'(platform, body) {
      const uid = this._uid(body, 'id');
      const group = typeof body.group === 'string' ? body.group : '';
      if (group.length > 64 || /[\r\n\t/\\]/.test(group)) throw new Error('分组名无效');
      await this._json(platform, '/__admin/groups/set', { method: 'POST', body: { uids: [uid], group } });
      return { ok: true, id: uid, group };
    },
  },

  codearts: {
    async 'account-toggle'(platform, body) {
      const uid = this._uid(body, 'id');
      const enabled = body.enabled !== false;
      const endpoint = enabled ? '/admin/api/accounts/enable' : '/admin/api/accounts/disable';
      const r = await this._json(platform, endpoint, {
        method: 'POST', headers: this._authHeaders(platform), body: { uid },
      });
      return { ok: r.ok !== false, id: uid, enabled, message: redact(r.message || '') };
    },
    async 'account-clear-cooldown'(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, '/admin/api/accounts/clear-cooldown', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid },
      });
      return { ok: r.ok !== false, id: uid, message: redact(r.message || '') };
    },
    async 'account-note'(platform, body) {
      const uid = this._uid(body, 'id');
      const note = typeof body.note === 'string' ? body.note : '';
      if (note.length > 200) throw new Error('备注过长（最多 200 字）');
      const r = await this._json(platform, '/admin/api/accounts/note', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid, note },
      });
      return { ok: r.ok !== false, id: uid, note, message: redact(r.message || '') };
    },
    async 'account-remove'(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, '/admin/api/accounts/delete', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid },
      });
      return { ok: r.ok !== false, id: uid, removed: true, message: redact(r.message || '') };
    },
    async checkin(platform, body) {
      // 单账号签到；不带 uid = 全部（内核语义）。这里只允许单账号，避免误点全量。
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, '/admin/api/checkin', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid },
      });
      const row = arr(r.results)[0] || {};
      return {
        ok: row.ok !== false && r.ok !== false,
        id: uid,
        credits: num(row.credits),
        message: redact(row.message || r.message || ''),
      };
    },
    async 'credits-refresh'(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, '/admin/api/credits', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid },
      });
      const row = arr(r.results)[0] || {};
      return { ok: row.ok !== false, id: uid, credits: num(row.credits), message: redact(row.message || '') };
    },
    async 'checkin-all'(platform) {
      // 空 uid = 内核语义的「全部账号」（admin.go pickTargets）。与逐号签到
      // 走的是同一端点，只是不给 uid；逐个点一遍对几十个号不现实。
      const r = await this._json(platform, '/admin/api/checkin', {
        method: 'POST', headers: this._authHeaders(platform), body: { uid: '' },
      });
      const rows = arr(r.results);
      return {
        ok: r.ok !== false,
        count: rows.length,
        succeeded: rows.filter((x) => x && x.ok !== false).length,
        message: redact(r.message || ''),
      };
    },
  },

  loomy: {
    async 'account-toggle'(platform, body) {
      const name = this._uid(body, 'id');
      const enabled = body.enabled !== false;
      const r = await this._json(platform, '/api/panel/accounts/update', {
        method: 'POST', headers: this._authHeaders(platform), body: { name, enabled },
      });
      return { ok: r.ok !== false, id: name, enabled, message: redact(r.message || '') };
    },
    async 'account-remove'(platform, body) {
      const name = this._uid(body, 'id');
      const r = await this._json(platform, '/api/panel/accounts/remove', {
        method: 'POST', headers: this._authHeaders(platform), body: { name },
      });
      return { ok: r.ok !== false, id: name, removed: bool(r.removed) || r.ok !== false, message: redact(r.message || '') };
    },
    async 'account-check'(platform, body) {
      // 单账号体检（不带 force = 只修复看起来坏掉的）
      const name = this._uid(body, 'id');
      const r = await this._json(platform, '/api/panel/accounts/check', {
        method: 'POST', headers: this._authHeaders(platform), body: { names: [name] },
      });
      return {
        ok: r.ok !== false, id: name,
        checked: num(r.checked) ?? null, repaired: num(r.repaired) ?? null,
        failed: num(r.failed) ?? null, message: redact(r.message || ''),
      };
    },
    async checkin(platform, body) {
      const name = this._uid(body, 'id');
      const r = await this._json(platform, '/api/panel/points/checkin', {
        method: 'POST', headers: this._authHeaders(platform), body: { name },
      });
      return {
        ok: r.ok !== false, id: name, already: bool(r.already),
        balance: num(r.current_balance), permanent: num(r.permanent_balance),
        daily: num(r.daily_balance), code: num(r.code), message: redact(r.message || ''),
      };
    },
    async 'checkin-all'(platform) {
      // Loomy 没有全量签到端点：它的 /api/panel/points/checkin 每次只处理
      // 一个账号（_pick_account 拿不到 name 时选「首个可用账号」，重复调用
      // 只会反复签同一个号）。所以这里按账号逐个签，并在壳内并发，
      // 上限 4，避免几十个号逐个串行把请求拖到超时（实测单号约 0.8s）。
      const state = await this._json(platform, '/api/panel/state', { headers: this._authHeaders(platform) });
      const names = arr(state.accounts)
        .filter((a) => a && typeof a.name === 'string' && a.enabled !== false)
        .map((a) => a.name);
      if (!names.length) return { ok: true, count: 0, succeeded: 0, skipped: true, message: '没有已启用的账号' };

      let cursor = 0;
      const results = [];
      const worker = async () => {
        while (cursor < names.length) {
          const name = names[cursor++];
          try {
            const r = await this._json(platform, '/api/panel/points/checkin', {
              method: 'POST', headers: this._authHeaders(platform), body: { name },
            });
            results.push({ name, ok: r.ok !== false, already: bool(r.already) });
          } catch (e) {
            results.push({ name, ok: false, message: redact(e.message) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
      const failed = results.filter((r) => !r.ok);
      const already = results.filter((r) => r.ok && r.already).length;
      return {
        ok: failed.length === 0, count: names.length, succeeded: results.length - failed.length,
        already,
        message: failed.length ? `${failed.length} 个账号签到失败，请查看日志` : '全部账号已签到',
      };
    },
  },

  lingxi: {
    async 'account-toggle'(platform, body) {
      const uid = this._uid(body, 'id');
      const enabled = body.enabled !== false;
      const endpoint = `/panel/api/accounts/${encodeURIComponent(uid)}/${enabled ? 'revive' : 'disable'}`;
      const r = await this._json(platform, endpoint, {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      return { ok: r.ok !== false, id: uid, enabled, message: redact(r.message || '') };
    },
    async 'account-pause'(platform, body) {
      const uid = this._uid(body, 'id');
      const paused = body.paused !== false;
      const endpoint = `/panel/api/accounts/${encodeURIComponent(uid)}/${paused ? 'pause' : 'resume'}`;
      const r = await this._json(platform, endpoint, {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      return { ok: r.ok !== false, id: uid, paused, message: redact(r.message || '') };
    },
    async 'account-remove'(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, `/panel/api/accounts/${encodeURIComponent(uid)}/remove`, {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      return { ok: r.ok !== false, id: uid, removed: true, message: redact(r.message || '') };
    },
    async checkin(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, `/panel/api/accounts/${encodeURIComponent(uid)}/checkin`, {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      // 内核返回 {ok, checkin_done, checkin_message?, enterprise?, credits?/balance_error?}
      return {
        ok: r.ok !== false && !r.balance_error,
        id: uid,
        done: bool(r.checkin_done),
        // 幂等拒绝（今天已签到）也走 ok=true + done=true，文案里能看出区别
        message: redact(r.checkin_message || r.balance_error || ''),
        enterprise: bool(r.enterprise),
        credits: num(r.credits ?? r.remaining),
      };
    },
    async 'balance-refresh'(platform, body) {
      const uid = this._uid(body, 'id');
      const r = await this._json(platform, `/panel/api/accounts/${encodeURIComponent(uid)}/balance`, {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      return { ok: r.ok !== false, id: uid, credits: num(r.credits), message: redact(r.message || '') };
    },
    async 'checkin-all'(platform) {
      // 内核自带全量签到端点（panel.go checkinAll）：异步触发，进度看日志。
      const r = await this._json(platform, '/panel/api/checkin_all', {
        method: 'POST', headers: this._authHeaders(platform), body: {},
      });
      return { ok: r.ok !== false, started: bool(r.started) || true, message: '已触达全量签到（后台执行，进度见日志）' };
    },
  },
};

module.exports = { GatewayPanel, CAPS, redact };