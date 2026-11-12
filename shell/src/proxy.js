'use strict';
/**
 * proxy.js — 壳自身出网的代理选择（纯 Node 模块）
 *
 * 为什么需要它：Node 的 http/https **默认不读**任何代理环境变量，国内直连
 * GitHub 会间歇性 ETIMEDOUT，表现就是「更新下载全部失败」。但系统代理又常把
 * GitHub 挡成 403（本机实测系统代理与 ALL_PROXY 都是 403，直连反而是通的），
 * 所以不做自动探测，一律由用户在设置里显式开启并指定地址。
 *
 * 边界：各网关平台（workbuddy / codearts / loomy / lingxi）的代理**不归这里管**。
 * 它们的子进程环境里 HTTP(S)_PROXY 被显式清掉并设 no_proxy=*（platform-manager），
 * 由各家自己的配置决定；这里只覆盖壳自己，以及写进 magpie 的那两项设置。
 *
 * 用途（purpose）与设置里的勾选项一一对应：
 *   selfUpdate        壳自更新（electron-updater）
 *   platformUpdate    平台更新（GitHub API 检查 + 资产下载）
 *   pluginRegistry    magpie 插件市场目录
 *   magpieKernel      magpie 内核版本检测与下载
 * magpie 自己的两项（订阅流量 / 插件流量）不用 agent，而是写进它的设置，见
 * MAGPIE_SCOPE_KEYS。
 */

/** 壳 agent 覆盖的用途 */
const PURPOSES = ['selfUpdate', 'platformUpdate', 'pluginRegistry', 'magpieKernel'];

/** 设置里的勾选项 → magpie 自己的设置键（这两项由 magpie 执行，不走壳 agent） */
const MAGPIE_SCOPE_KEYS = {
  magpieSubscription: 'proxy',
  magpiePlugin: 'pluginProxy',
};

const ALL_SCOPES = [...PURPOSES, ...Object.keys(MAGPIE_SCOPE_KEYS)];

/** 默认全部关闭：代理是用户显式选择的行为，不默认劫持任何流量 */
function defaultScopes() {
  const out = {};
  for (const s of ALL_SCOPES) out[s] = false;
  return out;
}

let _store = null;
// agent 按 proxy url 缓存：每个请求 new 一个 agent 会丢失连接复用，
// 更新下载动辄几十 MB，这点很关键。
const _agents = new Map();

/** 由 main.js 注入 ConfigStore（避免 config.js ←→ proxy.js 循环依赖） */
function init(store) {
  _store = store;
  _agents.clear();
}

/** 规整后的代理配置（永远返回完整形状，便于前端与日志使用） */
function config() {
  const raw = (_store && _store.manager && _store.manager.proxy) || {};
  const scopes = { ...defaultScopes(), ...(raw.scopes || {}) };
  // 只保留已知用途，避免配置里塞进任意键
  for (const k of Object.keys(scopes)) if (!ALL_SCOPES.includes(k)) delete scopes[k];
  return {
    enabled: !!raw.enabled,
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
    scopes,
  };
}

/** 代理地址是否可用（协议白名单，挡掉 file: 之类被当成代理的输入） */
function validProxyUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return ['http:', 'https:', 'socks:', 'socks5:', 'socks4:'].includes(u.protocol) && !!u.hostname;
}

/**
 * 该用途本次是否走代理；走则返回可用的 agent，否则 undefined。
 *
 * 依赖缺失时**降级为直连并保持可用**：代理包若没进生产依赖（打包裁剪），
 * 不该让整个更新功能崩掉，只是代理不生效。
 */
function agentFor(purpose) {
  const c = config();
  if (!c.enabled || !validProxyUrl(c.url)) return undefined;
  if (!c.scopes[purpose]) return undefined;

  if (_agents.has(c.url)) return _agents.get(c.url);
  let agent;
  try {
    const u = new URL(c.url);
    if (u.protocol.startsWith('socks')) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      agent = new SocksProxyAgent(c.url);
    } else {
      // http(s) 目标都能用 CONNECT 隧道；https 目标用 HttpsProxyAgent
      const { HttpsProxyAgent } = require('https-proxy-agent');
      agent = new HttpsProxyAgent(c.url);
    }
  } catch (e) {
    // 依赖缺失/地址不被支持：直连，不阻断功能
    _log(`[proxy] 无法创建代理 agent（回退直连）: ${e.message}`);
    return undefined;
  }
  _agents.set(c.url, agent);
  return agent;
}

/** Node http/https 请求选项合并：只在需要时加 agent */
function withAgent(purpose, opts = {}) {
  const agent = agentFor(purpose);
  return agent ? { ...opts, agent } : opts;
}

/**
 * 用给定地址真的发一次请求，验证代理能不能用。
 *
 * 必须真的走一遍：代理「建得出 agent」不等于「连得通」——端口写错、代理没开、
 * 认证失败、目标被代理挡住（本机系统代理对 GitHub 就是 403）都只有实发才知道。
 * 所以对比「走代理」与「直连」两次结果，让用户能分清「代理坏了」还是
 * 「这个目标本来就不通」。
 *
 * @returns {Promise<{ok:boolean, viaProxy:object, direct:object, verdict:string}>}
 */
async function verify(url, { target = 'https://api.github.com/', timeoutMs = 8000 } = {}) {
  const mod = target.startsWith('https:') ? require('https') : require('http');
  const probe = (agent) => new Promise((resolve) => {
    const started = Date.now();
    const req = mod.get(target, { timeout: timeoutMs, ...(agent ? { agent } : {}) }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `超时（${timeoutMs}ms）`, ms: Date.now() - started }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }));
  });

  const result = { viaProxy: null, direct: null, verdict: '', usable: false };
  // 直连与走代理都测：只测代理无法判断「代理坏了」还是「这个目标本身不通」
  result.direct = await probe(null);
  if (!validProxyUrl(url)) {
    result.verdict = '代理地址无效（需 http(s):// 或 socks5:// 且带主机名）';
    return { ok: false, ...result };
  }
  let agent;
  try {
    const u = new URL(url);
    agent = u.protocol.startsWith('socks')
      ? new (require('socks-proxy-agent').SocksProxyAgent)(url)
      : new (require('https-proxy-agent').HttpsProxyAgent)(url);
  } catch (e) {
    result.verdict = `无法建立代理连接：${e.message}`;
    return { ok: false, ...result };
  }
  result.viaProxy = await probe(agent);

  // 判定「代理通不通」看的是**有没有收到 HTTP 响应**，不是看状态码：
  // 能收到 403/404 说明 TCP + 代理隧道 + TLS + HTTP 全都走通了，
  // 那只是目标侧的回绝（GitHub 限额 403 就是这么来的）。
  // 把 403 当成「代理不可用」会让人以为代理坏了，实际是限流。
  const reached = (r) => !!r && typeof r.status === 'number';
  result.usable = reached(result.viaProxy);
  const viaDesc = (r) => (reached(r) ? `HTTP ${r.status} · ${r.ms}ms` : (r?.error || '—'));
  const directDesc = (r) => (reached(r) ? `HTTP ${r.status} · ${r.ms}ms` : (r?.error || '—'));
  result.summary = { viaProxy: viaDesc(result.viaProxy), direct: directDesc(result.direct) };

  if (!reached(result.viaProxy)) {
    result.verdict = reached(result.direct)
      ? `代理连不上（${result.viaProxy.error}），但直连正常——这台机器不需要代理`
      : `代理连不上（${result.viaProxy.error}），直连也不通——先检查本机网络`;
  } else if (result.viaProxy.status === 403) {
    // 走到了 GitHub，只是被限额/拒绝。这是「代理可用」而不是「代理不可用」
    result.verdict = '代理可用（已连到 GitHub）；403 是 GitHub 的未登录限流（60 次/小时），在「更新」里填 GitHub Token 可提升到 5000 次';
  } else if (result.viaProxy.status >= 400) {
    result.verdict = `代理可用（已连到目标）；目标返回 HTTP ${result.viaProxy.status}`;
  } else {
    result.verdict = reached(result.direct)
      ? '代理可用（直连也通，可比延迟取舍）'
      : '代理可用（直连不通，走代理解决了问题）';
  }
  // ok 仍表示「代理完全可用且目标正常应答」，供脚本一键判断；usable 表示「代理本身通」
  return { ok: result.usable && result.viaProxy.status < 400, ...result };
}

/**
 * magpie 自己那两项要写入的值。
 *
 * magpie 的取值语义（实测）：
 *   ""        跟随系统代理（默认）—— 注意系统代理常是坏的，空值并不等于
 *             「不用代理」。本机系统代理对 GitHub 就是 403。
 *   "direct"  明确不用代理
 *   <url>     指定代理
 *
 * 所以「勾选」= 写入地址；「未勾选」= 写 direct，而不是空串——否则取消
 * 勾选后会落回系统代理，与用户的意图相反。
 */
function magpieEnv() {
  const c = config();
  const usable = c.enabled && validProxyUrl(c.url) ? c.url : '';
  const out = {};
  for (const [scope, key] of Object.entries(MAGPIE_SCOPE_KEYS)) {
    out[key] = c.scopes[scope] && usable ? usable : 'direct';
  }
  return out;
}

let _log = () => {};
function setLogger(fn) { if (typeof fn === 'function') _log = fn; }

module.exports = {
  PURPOSES, ALL_SCOPES, MAGPIE_SCOPE_KEYS,
  init, config, agentFor, withAgent, magpieEnv, validProxyUrl, defaultScopes, setLogger, verify,
};
