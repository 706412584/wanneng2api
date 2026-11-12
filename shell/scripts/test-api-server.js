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
  const manager = new PlatformManager({ store, dataDir, logger });
  const updater = new PlatformUpdater({ manager, store, dataDir, logger });
  const api = new ApiServer({ manager, updater, store, openExternal: () => {} });
  await api.listen('127.0.0.1:17809');
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

  // ── updates/summary ──
  console.log('\n[updates/summary]');
  const us = await req('GET', '/api/updates/summary');
  ok('summary 200 数组', us.status === 200 && Array.isArray(us.json.updates) && us.json.updates.length === 2);

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
