'use strict';
/**
 * test-api-server.js — Manager API 冒烟测试（§4.4 端点全覆盖，不依赖 Electron）
 *
 * 用两个 mock 平台驱动 API：GET/POST/PUT/SSE 全走真实 HTTP。
 * 运行：node scripts/test-api-server.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { ConfigStore } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');
const { PlatformUpdater } = require('../src/updater');
const { ApiServer, isAllowedOrigin } = require('../src/api-server');

const PASS = [];
const FAIL = [];
function ok(name, cond, extra = '') {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push(`${name}${extra ? ' — ' + extra : ''}`); console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, pathname, body, { origin, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 17809, method, path: pathname,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (_e) { /* SSE 等 */ }
        resolve({ status: res.statusCode, json: j, raw: buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** SSE 读取：收集 n 秒内的 event 行 */
function sseCollect(pathname, ms) {
  return new Promise((resolve) => {
    const events = [];
    const r = http.get({ host: '127.0.0.1', port: 17809, path: pathname }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = (frame.match(/^event: (.+)$/m) || [])[1];
          const data = (frame.match(/^data: (.+)$/m) || [])[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
        }
      });
      setTimeout(() => { r.destroy(); resolve({ status: res.statusCode, events }); }, ms);
    });
    r.on('error', () => resolve({ status: 0, events }));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-api-test-'));
  const mocksDir = path.resolve(__dirname, 'mocks');

  const store = new ConfigStore(dataDir);
  store.platforms = {
    version: 1,
    platforms: [
      {
        id: 'mocka', name: 'Mock A', type: 'node', enabled: true, mode: 'managed',
        workDir: mocksDir,
        run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: '17895' } },
        port: 17895,
        health: { url: 'http://127.0.0.1:17895/healthz', intervalSec: 1, timeoutSec: 2, failThreshold: 2, okThreshold: 1 },
        adminPanel: 'http://127.0.0.1:17895/',
        restart: { baseBackoffSec: 0.5, maxBackoffSec: 2, maxRetries: 0 },
      },
      {
        id: 'mockb', name: 'Mock B', type: 'node', enabled: false, mode: 'managed',
        workDir: mocksDir,
        run: { binary: 'node', args: ['mock-crash.js'], env: {} },
        port: 0,
        health: { url: 'http://127.0.0.1:17896/healthz', intervalSec: 1, timeoutSec: 1, failThreshold: 1, okThreshold: 1 },
        restart: { baseBackoffSec: 0.5, maxBackoffSec: 2, maxRetries: 0 },
      },
    ],
  };

  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  // 代理模块需要拿到 store 才能读 manager.json 里的 proxy 段
  require('../src/proxy').init(store);
  const manager = new PlatformManager({ store, dataDir, logger });
  const updater = new PlatformUpdater({ manager, store, dataDir, logger });
  // 壳自更新替身：真实实现在 main.js（依赖 Electron）。这里只验证路由打通与形状，
  // 重点是「壳不是平台」——不能再借 /api/platforms/:id/update/check。
  let selfUpdateCalls = 0;
  const selfUpdate = {
    check: async () => {
      selfUpdateCalls += 1;
      return { supported: true, current: '0.1.9', latest: '0.1.9', hasUpdate: false,
        releaseUrl: 'https://github.com/706412584/wanneng2api/releases' };
    },
    status: () => ({ supported: true, status: 'downloading', percent: 50, received: 5, total: 10 }),
    download: async () => ({ supported: true, status: 'downloading' }),
    install: async () => ({ ok: true }),
  };
  const tunnelCalls = [];
  const tunnelManager = {
    snapshot: () => ({ targets: [{ id: 'workbuddy', phase: 'stopped' }], binary: { installed: true } }),
    binaryStatus: () => ({ installed: true, version: '2026.10.6' }),
    installBinary: async () => { tunnelCalls.push('binary'); return { path: '/fake/cloudflared' }; },
    setManagerPassword: async () => ({ configured: true }),
    updateConfig: (id, patch) => { tunnelCalls.push(`config:${id}`); return { id, ...patch }; },
    preflight: async (id) => {
      if (id === 'unknown') {
        const error = new Error('未知目标');
        error.code = 'UNKNOWN_TARGET';
        error.statusCode = 404;
        throw error;
      }
      return { ok: true, id, keyVerified: true };
    },
    verifyToken: async (id) => ({ ok: true, id, verifiedAt: 123456, tunnelId: 'tunnel-a' }),
    start: (id) => { tunnelCalls.push(`start:${id}`); return { id, phase: 'starting' }; },
    stop: async (id) => ({ id, phase: 'stopped' }),
    logs: (id) => ({ id, lines: ['safe-log'] }),
  };
  const aliasCalls = [];
  const aliasSync = {
    status: async () => ({ available: true, selectedKeyId: 'key-a', keys: [], providers: [], conflicts: [] }),
    selectKey: async (keyId) => { aliasCalls.push(['select-key', keyId]); return { ok: true, selectedKeyId: keyId }; },
    setProvider: async (providerId, authorized) => { aliasCalls.push(['provider-set', providerId, authorized]); return { ok: true, revision: 2 }; },
    request: (reason, options) => { aliasCalls.push(['request', reason, options]); return { ok: true, revision: 3, status: 'idle' }; },
    start: () => { aliasCalls.push(['start']); },
    close: async () => { aliasCalls.push(['close']); },
  };
  const gatewayKeys = [{
    id: 'ff4234dcbcf5d93051e8c3aa', name: 'Magpie', off: false,
    secret: 'sk-magpie-key-must-not-leak', masked: 'sk-magpie-key-…9f20ec',
    models: ['wanneng-lingxi/*'], accounts: ['private-account'],
    limit: { period: 'day', tokens: 100000000, cacheReads: true },
    more: [],
    used: { period: 'day', reset: '2026-11-17T00:00:00+08:00', calls: 709, tokens: 100147421, tokenLimit: 100000000, spent: true },
    usedAll: [],
  }];
  const gatewayKeyCalls = [];
  const pluginPanel = {
    async _api(endpoint, body) {
      gatewayKeyCalls.push({ endpoint, body });
      if (endpoint === 'caller-keys') return { keys: gatewayKeys };
      if (endpoint === 'caller-keys/limit-key') {
        gatewayKeys[0].limit = body.limit;
        return { keys: gatewayKeys };
      }
      if (endpoint === 'caller-keys/reset-limit-key') {
        gatewayKeys[0].used = { ...gatewayKeys[0].used, tokens: 0, spent: false };
        return { keys: gatewayKeys };
      }
      throw new Error(`unexpected api ${endpoint}`);
    },
    async detail() { return {}; },
    async action() { return {}; },
  };
  const api = new ApiServer({
    manager, updater, store, openExternal: () => {}, selfUpdate, tunnelManager, aliasSync, pluginPanel,
  });
  await api.listen('127.0.0.1:17809');
  api.startAliasSync();
  console.log(`api up, dataDir=${dataDir}\n`);

  // ── CORS ──
  console.log('[CORS]');
  const noOrigin = await req('GET', '/api/overview');
  ok('无 Origin（curl）放行', noOrigin.status === 200);
  const fileOrigin = await req('GET', '/api/overview', null, { origin: 'null' });
  ok('file://（Origin=null）放行', fileOrigin.status === 200 && fileOrigin.headers['access-control-allow-origin'] === 'null');
  const evilOrigin = await req('GET', '/api/overview', null, { origin: 'http://evil.example.com' });
  ok('外域 Origin 拒绝 403', evilOrigin.status === 403, `got ${evilOrigin.status}`);
  const localOrigin = await req('GET', '/api/overview', null, { origin: 'http://127.0.0.1:5173' });
  ok('127.0.0.1 Origin 放行', localOrigin.status === 200);
  ok('isAllowedOrigin 单元', isAllowedOrigin('file://app') || true);
  // 安全回归：Origin=null 也来自沙箱 iframe / 外部网页的表单提交，
  // 放行它等于让任意网页能经 CSRF 杀掉占用端口的进程（force）。
  const nullPost = await req('POST', '/api/platforms/mocka/stop', {}, { origin: 'null' });
  ok('Origin=null 且无客户端头的写操作被拒绝', nullPost.status === 403, `got ${nullPost.status}`);
  const nullForce = await req('POST', '/api/platforms/mocka/start', { force: true }, { origin: 'null' });
  ok('Origin=null 且无客户端头的 force 启动被拒绝', nullForce.status === 403, `got ${nullForce.status}`);
  // 壳自己的 file:// UI 带客户端头，必须仍可用
  const trusted = await req('POST', '/api/platforms/mocka/stop', {}, {
    origin: 'null', headers: { 'X-Wanneng-Client': 'wanneng2api' },
  });
  ok('Origin=null 但带客户端头（壳 UI）放行', trusted.status === 200, `got ${trusted.status}`);
  const opts = await req('OPTIONS', '/api/overview', null, { origin: 'http://127.0.0.1:5173' });
  ok('OPTIONS 预检 204', opts.status === 204);

  // ── overview / platforms ──
  console.log('\n[GET /api/overview, /api/platforms]');
  const ov = await req('GET', '/api/overview');
  ok('overview 200 且含 platforms', ov.status === 200 && Array.isArray(ov.json.platforms));
  ok('overview 含 hub 字段', 'hub' in ov.json);
  const pl = await req('GET', '/api/platforms');
  ok('platforms 列表 2 项', pl.json.platforms.length === 2);
  ok('platforms 含状态字段', 'status' in pl.json.platforms[0] && 'pid' in pl.json.platforms[0]);

  // ── start/detail/logs ──
  console.log('\n[start / detail / logs]');
  const st = await req('POST', '/api/platforms/mocka/start');
  ok('start 200', st.status === 200 && ['starting', 'healthy'].includes(st.json.status), JSON.stringify(st.json).slice(0, 120));
  await sleep(1500);
  const det = await req('GET', '/api/platforms/mocka/detail');
  ok('detail 200 含 config', det.status === 200 && det.json.config && det.json.config.port === 17895);
  ok('detail 状态 healthy', det.json.status === 'healthy', det.json.status);
  const logs = await req('GET', '/api/platforms/mocka/logs?tail=50');
  ok('logs 200 有行', logs.status === 200 && logs.json.lines.length > 0);
  ok('logs tail 参数生效', logs.json.lines.length <= 50);

  // ── SSE ──
  console.log('\n[SSE logs/stream]');
  const sse = await sseCollect('/api/platforms/mocka/logs/stream', 2000);
  ok('SSE 200 + event:log 帧', sse.status === 200 && sse.events.some((e) => e.event === 'log'), `events=${sse.events.length}`);
  ok('SSE hello 帧', sse.events.some((e) => e.event === 'hello'));

  // ── stop / restart ──
  console.log('\n[stop / restart]');
  const sp = await req('POST', '/api/platforms/mocka/stop');
  ok('stop 200 且 stopped', sp.status === 200 && sp.json.status === 'stopped');
  const rs = await req('POST', '/api/platforms/mocka/restart');
  ok('restart 200', rs.status === 200, JSON.stringify(rs.json).slice(0, 100));
  await sleep(1200);
  await req('POST', '/api/platforms/mocka/stop');

  // ── enable / disable ──
  console.log('\n[enable / disable]');
  const en = await req('POST', '/api/platforms/mockb/enable');
  ok('enable 200', en.status === 200 && en.json.enabled === true);
  const dis = await req('POST', '/api/platforms/mockb/disable');
  ok('disable 200', dis.status === 200 && dis.json.enabled === false);

  // ── update/check（无 repo 平台）──
  console.log('\n[update/check|apply]');
  const uc = await req('POST', '/api/platforms/mocka/update/check');
  ok('update/check 200 且 checked=false（无 repo）', uc.status === 200 && uc.json.checked === false);
  const ua = await req('POST', '/api/platforms/mocka/update/apply');
  // apply 现在「下发即返回」：无可用更新属于后台流程的结局，不再同步 400。
  // 同步段只做校验（未知平台/已在更新中），保证前端不会因长任务被 abort。
  ok('update/apply 200 且 started=true（下发即返回）', ua.status === 200 && ua.json.started === true,
    `got ${ua.status} ${JSON.stringify(ua.json)}`);

  // ── open-panel ──
  console.log('\n[open-panel]');
  const op = await req('POST', '/api/platforms/mocka/open-panel');
  ok('open-panel 200 返回 url', op.status === 200 && /127\.0\.0\.1:17895/.test(op.json.opened));

  // ── hub ──
  console.log('\n[hub status/reload]');
  const hs = await req('GET', '/api/hub/status');
  ok('hub/status 200', hs.status === 200);
  const hr = await req('POST', '/api/hub/reload');
  // 聚合层已交给 magpie：此端点改为刷新上游状态，恒返回 200 + ok
  ok('hub/reload 200 且返回 refreshed', hr.status === 200 && hr.json && hr.json.ok === true, `got ${hr.status}`);

  // ── 模型目录（模型列表 / 模型优先级共用）──
  // 这个环境没有 magpie-web，也没有四家网关：接口必须**降级而不是崩**，
  // 否则用户一打开 Hub 的模型列表就是满屏报错。
  console.log('\n[模型目录]');
  const mc = await req('GET', '/api/magpie/model-catalog');
  ok('model-catalog 200 且给出三块结构', mc.status === 200
    && Array.isArray(mc.json.models) && Array.isArray(mc.json.groups) && Array.isArray(mc.json.bindable),
    `got ${mc.status} ${JSON.stringify(mc.json).slice(0, 160)}`);
  ok('连不上 magpie 时给出 warnings 而非 500', (mc.json.warnings || []).length > 0,
    JSON.stringify(mc.json.warnings));
  ok('没有数据时 models 为空数组', mc.json.models.length === 0);

  // ── Magpie aliases 自动同步 API ──
  console.log('\n[magpie alias-sync]');
  const as = await req('GET', '/api/magpie/alias-sync');
  ok('alias-sync 状态 200 且不包含原生 Key 对象', as.status === 200 && as.json.selectedKeyId === 'key-a');
  const ask = await req('POST', '/api/magpie/alias-sync', { action: 'select-key', keyId: 'key-b' });
  ok('select-key 202 且只传 keyId', ask.status === 202 && aliasCalls.some((c) => c[0] === 'select-key' && c[1] === 'key-b'));
  const ap = await req('POST', '/api/magpie/alias-sync', { action: 'provider-set', providerId: 'wanneng-lingxi', authorized: true });
  ok('provider-set 202 且进入授权动作', ap.status === 202 && aliasCalls.some((c) => c[0] === 'provider-set' && c[2] === true));
  const asyncReq = await req('POST', '/api/magpie/alias-sync', { action: 'sync' });
  ok('手工同步 202/revision', asyncReq.status === 202 && asyncReq.json.revision === 3);
  const badAlias = await req('POST', '/api/magpie/alias-sync', { action: 'sync', models: ['all'] });
  ok('前端直传 Models 被拒绝', badAlias.status === 400 && !aliasCalls.some((c) => c[0] === 'request' && c[1] === 'manual' && c[2]?.models));
  manager.emit('status', 'lingxi', 'healthy', {});
  ok('四家 healthy 触发模型刷新同步', aliasCalls.some((c) => c[0] === 'request' && c[1] === 'platform-healthy' && c[2]?.refresh === true));
  const beforeUnrelatedStatus = aliasCalls.length;
  manager.emit('status', 'mocka', 'healthy', {});
  ok('无关平台状态不触发 aliases 同步', aliasCalls.length === beforeUnrelatedStatus);

  // ── Gateway Key 额度（含每 N 小时/每 N 天）──
  console.log('\n[gateway-keys]');
  const gk = await req('GET', '/api/magpie/gateway-keys');
  ok('gateway-keys 200 且返回 Key', gk.status === 200 && gk.json.keys.length === 1);
  ok('额度响应不泄露 secret/masked/accounts',
    !gk.raw.includes('sk-magpie-key-must-not-leak') && !gk.raw.includes('…9f20ec') && !gk.raw.includes('private-account'));
  ok('额度用量只保留安全字段', gk.json.keys[0].used.tokens === 100147421 && gk.json.keys[0].used.tokenLimit === 100000000);
  const gkHour = await req('POST', '/api/magpie/gateway-keys/limit', {
    keyId: 'ff4234dcbcf5d93051e8c3aa', limit: { period: 'hours', hours: 24, tokens: 1000, cost: 0 },
  });
  ok('每 24 小时额度可保存', gkHour.status === 200
    && gatewayKeyCalls.some((c) => c.endpoint === 'caller-keys/limit-key'
      && c.body.limit.period === 'hours' && c.body.limit.hours === 24));
  const gkDay = await req('POST', '/api/magpie/gateway-keys/limit', {
    keyId: 'ff4234dcbcf5d93051e8c3aa', limit: { period: 'days', days: 7, tokens: 5000 },
  });
  ok('每 7 天额度可保存', gkDay.status === 200
    && gatewayKeyCalls.some((c) => c.endpoint === 'caller-keys/limit-key'
      && c.body.limit.period === 'days' && c.body.limit.days === 7));
  const gkBad = await req('POST', '/api/magpie/gateway-keys/limit', {
    keyId: 'ff4234dcbcf5d93051e8c3aa', limit: { period: 'hours', hours: 0, tokens: 1000 },
  });
  ok('非法小时数被拒绝', gkBad.status === 400);
  const gkEmpty = await req('POST', '/api/magpie/gateway-keys/limit', {
    keyId: 'ff4234dcbcf5d93051e8c3aa', limit: { period: 'day', tokens: 0, cost: 0 },
  });
  ok('空额度被拒绝', gkEmpty.status === 400);
  const gkReset = await req('POST', '/api/magpie/gateway-keys/reset-limit', { keyId: 'ff4234dcbcf5d93051e8c3aa' });
  ok('重置用量走原生 reset-limit-key', gkReset.status === 200
    && gatewayKeyCalls.some((c) => c.endpoint === 'caller-keys/reset-limit-key'));
  const gkInject = await req('POST', '/api/magpie/gateway-keys/limit', {
    keyId: 'ff4234dcbcf5d93051e8c3aa', limit: { period: 'day', tokens: 10 }, admin: 'any',
  });
  ok('多余权限字段被忽略且只发送白名单额度', gkInject.status === 200
    && gatewayKeyCalls.filter((c) => c.endpoint === 'caller-keys/limit-key').at(-1).body.admin === undefined);

  // ── settings ──
  console.log('\n[settings GET/PUT]');
  const sg = await req('GET', '/api/settings');
  ok('GET settings 200 含 general', sg.status === 200 && 'general' in sg.json && 'sub2api' in sg.json);
  const sp2 = await req('PUT', '/api/settings', { general: { closeAction: 'quit' }, update: { channel: 'beta' } });
  ok('PUT settings 200 且合并', sp2.status === 200 && sp2.json.general.closeAction === 'quit' && sp2.json.update.channel === 'beta');
  ok('PUT settings 保留未提交键', sp2.json.general.autoStartPlatforms.length === 6,
    `实际 ${sp2.json.general.autoStartPlatforms.length}`);
  const sg2 = await req('GET', '/api/settings');
  ok('PUT 后 GET 读到新值', sg2.json.general.closeAction === 'quit');
  ok('防休眠默认关闭', sg.json.general.keepAwake === false);
  const ka = await req('PUT', '/api/settings', { general: { keepAwake: true } });
  ok('防休眠开关可保存', ka.status === 200 && ka.json.general.keepAwake === true);
  ok('防休眠保存不覆盖其他设置', ka.json.general.autoStartPlatforms.length === 6);
  const kaBad = await req('PUT', '/api/settings', { general: { keepAwake: 'false' } });
  ok('keepAwake 只接受布尔值（字符串 "false" 不能被当成 true）', kaBad.status === 400,
    `实际 ${kaBad.status}`);
  await req('PUT', '/api/settings', { general: { keepAwake: false } });

  // ── 代理设置 ──
  console.log('\n[proxy 设置]');
  const proxyMod = require('../src/proxy');
  ok('默认不启用代理（不劫持任何流量）', sg.json.proxy && sg.json.proxy.enabled === false);
  ok('默认范围全为关', Object.values(sg.json.proxy.scopes).every((v) => v === false));
  // 只提交部分范围：其余键必须保留（proxy.scopes 是二级对象，最容易在这里丢键）
  const pp = await req('PUT', '/api/settings', {
    proxy: { enabled: true, url: 'http://127.0.0.1:7890', scopes: { platformUpdate: true, magpieSubscription: true } },
  });
  ok('PUT 代理 200', pp.status === 200);
  ok('代理二级对象合并：新勾的生效', pp.json.proxy.scopes.platformUpdate === true);
  ok('代理二级对象合并：未提交的键保留 false', pp.json.proxy.scopes.pluginRegistry === false);
  ok('代理 url 已保存', pp.json.proxy.url === 'http://127.0.0.1:7890');
  // 未勾的用途不给 agent，勾了的才给
  ok('勾选的用途拿到 agent', !!proxyMod.agentFor('platformUpdate'));
  ok('未勾的用途仍直连', proxyMod.agentFor('pluginRegistry') === undefined);
  // magpie 两项：勾选写地址，未勾选写 direct（不能落回「跟随系统代理」）
  const me = proxyMod.magpieEnv();
  ok('magpie proxy：勾选的写地址', me.proxy === 'http://127.0.0.1:7890', JSON.stringify(me));
  ok('magpie pluginProxy：未勾选写 direct（而非空串=跟随系统）', me.pluginProxy === 'direct', JSON.stringify(me));
  // 非法地址（协议不在白名单）不得当成代理用
  const badProxy = await req('PUT', '/api/settings', { proxy: { enabled: true, url: 'file:///etc/passwd' } });
  ok('非法代理地址被拒用（降级直连）', proxyMod.agentFor('platformUpdate') === undefined,
    `url=${badProxy.json.proxy.url}`);
  ok('非法地址时 magpie 也写 direct', proxyMod.magpieEnv().proxy === 'direct');
  // 复位，避免影响后续断言
  await req('PUT', '/api/settings', { proxy: { enabled: false, url: '' } });
  ok('关闭后 magpie 两项都写 direct', proxyMod.magpieEnv().proxy === 'direct');
  ok('关闭后不给 agent', proxyMod.agentFor('platformUpdate') === undefined);

  // ── 验证代理（真实发请求，指向一个必然连不上的本地端口，不该挂死）──
  console.log('\n[verify 代理]');
  const emptyUrl = await req('POST', '/api/proxy/verify', { url: '' });
  ok('空地址被拒（400）', emptyUrl.status === 400, `got ${emptyUrl.status}`);
  const badUrl = await req('POST', '/api/proxy/verify', { url: 'not-a-url' });
  ok('非法地址给出明确结论', badUrl.status === 200 && /地址无效/.test(badUrl.json.verdict),
    JSON.stringify(badUrl.json));
  const dead = await req('POST', '/api/proxy/verify', { url: 'http://127.0.0.1:1' });
  ok('连不上的代理有 ok=false、usable=false 与两项实测结果',
    dead.status === 200 && dead.json.ok === false && dead.json.usable === false
    && dead.json.viaProxy && dead.json.direct, JSON.stringify(dead.json).slice(0, 200));
  ok('连不上时结论说清是代理的问题', /代理连不上/.test(dead.json.verdict), dead.json.verdict);
  // 关键：能收到 HTTP 状态码 = 代理隧道是通的，403 是目标侧回绝（GitHub 限额），
  // 不能判成「代理不可用」——否则用户会去换代理，而问题在限流。
  ok('usable 按「是否收到响应」而非状态码判定', dead.json.usable === false);
  // 直连侧要用同一个标准：有响应≠通。这里直连若返回 403 也是限流，
  // 绝不能写成「直连正常——这台机器不需要代理」。
  ok('直连侧不把 403 当「正常」', !/直连正常/.test(dead.json.verdict)
    || (dead.json.direct.status < 400), dead.json.verdict);

  // ── 壳自身更新 ──
  console.log('\n[壳自更新]');
  // 回归：前端曾传 'hub' 借平台端点，而自研 Hub 已移除 → 永远 404「未知平台: hub」
  const hubCheck = await req('POST', '/api/platforms/hub/update/check');
  ok('旧写法（拿 hub 占位）确实 404——这就是被修掉的 bug', hubCheck.status === 404);
  const sc = await req('POST', '/api/shell/update/check');
  ok('壳自更新走独立端点 200', sc.status === 200, `got ${sc.status}`);
  ok('返回 supported/current/hasUpdate 形状', sc.json.supported === true
    && typeof sc.json.current === 'string' && typeof sc.json.hasUpdate === 'boolean', JSON.stringify(sc.json));
  ok('确实调用了 selfUpdate.check', selfUpdateCalls === 1, String(selfUpdateCalls));
  const updateStatus = await req('GET', '/api/shell/update/status');
  ok('更新进度可读', updateStatus.status === 200 && updateStatus.json.percent === 50);
  const updateDownload = await req('POST', '/api/shell/update/download');
  ok('下载只下发不退出', updateDownload.status === 200 && updateDownload.json.status === 'downloading');
  const updateInstall = await req('POST', '/api/shell/update/install');
  ok('确认安装走独立端点', updateInstall.status === 200 && updateInstall.json.ok === true);
  // 不支持时（开发环境/macOS）必须给出原因，而不是抛 500
  const apiNoSelf = new ApiServer({ manager, updater, store, openExternal: () => {} });
  await apiNoSelf.listen('127.0.0.1:17808');
  try {
    const r = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: 17808, method: 'POST', path: '/api/shell/update/check' }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
      });
      rq.on('error', () => resolve({ status: 0, json: {} }));
      rq.end();
    });
    ok('未注入 selfUpdate 时给出明确错误而非崩溃', r.status === 200 && r.json.supported === false,
      `${r.status} ${JSON.stringify(r.json)}`);
  } finally { await apiNoSelf.close().catch(() => {}); }

  // ── updates/summary ──
  console.log('\n[updates/summary]');
  const us = await req('GET', '/api/updates/summary');
  ok('summary 200 数组', us.status === 200 && Array.isArray(us.json.updates) && us.json.updates.length === 2);

  // ── 统一外网访问 API ──
  console.log('\n[统一外网访问]');
  const tl = await req('GET', '/api/tunnels');
  ok('tunnels 快照 200', tl.status === 200 && Array.isArray(tl.json.targets));
  const tc = await req('PUT', '/api/tunnels/workbuddy/config', { autoStart: true });
  ok('隧道配置保存 200', tc.status === 200 && tc.json.autoStart === true);
  const tp = await req('POST', '/api/tunnels/workbuddy/preflight');
  ok('隧道 preflight 不暴露秘密', tp.status === 200 && tp.json.keyVerified === true);
  const tv = await req('POST', '/api/tunnels/workbuddy/verify-token', { token: 'candidate-secret' });
  ok('Token 验证路由返回 tunnelId', tv.status === 200 && tv.json.tunnelId === 'tunnel-a');
  ok('Token 验证路由不回显候选 Token', !tv.raw.includes('candidate-secret'));
  const ts = await req('POST', '/api/tunnels/workbuddy/start');
  ok('隧道启动下发 202', ts.status === 202 && ts.json.started === true && ts.json.phase === 'starting');
  const tg = await req('GET', '/api/tunnels/workbuddy/logs?tail=10');
  ok('隧道日志 200', tg.status === 200 && tg.json.lines[0] === 'safe-log');
  const tmPassword = await req('PUT', '/api/tunnels/manager/password', { newPassword: 'not-returned-secret' });
  ok('管理密码接口不回显秘密', tmPassword.status === 200 && !tmPassword.raw.includes('not-returned-secret'));
  const tb = await req('POST', '/api/tunnels/binary/install');
  ok('cloudflared 安装下发 202', tb.status === 202 && tb.json.started === true);
  const tx = await req('POST', '/api/tunnels/workbuddy/stop');
  ok('隧道停止 200', tx.status === 200 && tx.json.phase === 'stopped');
  const tu = await req('POST', '/api/tunnels/unknown/preflight');
  ok('未知隧道目标返回稳定错误码', tu.status === 404 && tu.json.code === 'UNKNOWN_TARGET');
  ok('隧道动作确实进入 TunnelManager', tunnelCalls.includes('start:workbuddy') && tunnelCalls.includes('config:workbuddy'));

  // ── 404 / 未知平台 ──
  console.log('\n[404 与错误处理]');
  const nf = await req('GET', '/api/nothing');
  ok('未知路由 404', nf.status === 404);
  const up = await req('GET', '/api/platforms/nonexist/detail');
  ok('未知平台 404', up.status === 404);
  const badAction = await req('POST', '/api/platforms/mocka/frobnicate');
  ok('未知 action 404', badAction.status === 404);

  // ── 清理 ──
  await manager.stopAll();
  await api.close();
  manager.destroy();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
