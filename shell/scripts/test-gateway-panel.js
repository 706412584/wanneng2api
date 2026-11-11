'use strict';
// 只使用本机 loopback 桩，不连接不启停任何真实网关。
const assert = require('node:assert/strict');
const http = require('node:http');

/**
 * 每家网关的桩服务：记录收到的请求，按固定 fixture 返回。
 * 用同一个端口号思路不现实（四家端口固定），所以这里让 GatewayPanel
 * 通过 getPlatform 返回桩监听的临时端口 —— 适配层只依赖 port 字段。
 */
function makeStub(handlers) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization || '' });
    const fn = handlers[u.pathname];
    if (!fn) { res.writeHead(404).end('not found'); return; }
    let out;
    try {
      out = await fn({ method: req.method, query: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization });
    } catch (e) {
      // handler 可以 throw 一个带 code 的错误来模拟上游的 401/403
      res.writeHead(e.code || 500).end(String(e.message));
      return;
    }
    if (out === 'raw:not-json') return res.end('{oops');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out ?? {}));
  });
  return { server, calls };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function main() {
  const { GatewayPanel } = require('../src/gateway-panel');

  // ── WorkBuddy 桩 ──
  const wb = makeStub({
    '/__admin/accounts': () => ({
      authDir: 'D:/x/auths',
      accounts: [
        { file: 'a.json', uid: 'u1', nickname: '号一', region: 'cn', domain: 'www.codebuddy.cn',
          expiresAt: 1796997600, expired: false, tokenHint: 'eyJhbG', disabled: false, inPool: true,
          lastSuccess: '2026-11-11T10:00:00Z', calls: [{ ok: true, at: '2026-11-11T10:00:00Z', status: 200 }] },
        { file: 'b.json', uid: 'u2', nickname: '号二', region: 'global', expired: true, disabled: true,
          disabledReason: '12153 session dead', inPool: false, deprecatedSecret: 'never-return' },
      ],
    }),
    '/__admin/stats': () => ({
      totalRequests: 754, ok: 708, errors: 46, successRate: 0.939, tokensTotal: 501312,
      statusCounts: [{ status: 200, count: 700 }, { status: 429, count: 54 }],
      byAccount: [{ key: 'u1', requests: 10, ok: 9, errors: 1, tokens: 100, successRate: 0.9, avgTtfbMs: 100, avgTokps: 20 }],
      byModel: [{ key: 'm1', requests: 10, ok: 9, errors: 1, tokens: 100, successRate: 0.9 }],
    }),
    '/__admin/groups': () => ({ available: true, names: ['可用真号'], emptyNames: [], groups: { u1: '可用真号' } }),
    '/__admin/schedule': () => ({
      now: '2026-11-12T00:00:00Z',
      tasks: [{ key: 'checkin', label: '签到', enabled: true, quiet: true, hours: [9, 21],
        nextRun: '2026-11-12T01:00:00Z', lastRun: null, note: '' }],
    }),
    '/__admin/logs': () => ({ lines: ['l1', 'l2'] }),
    '/__admin/accounts/toggle': ({ body }) => ({ ok: true, uid: body.uid, disabled: body.disabled }),
    '/__admin/accounts/test': ({ body }) => ({ ok: true, uid: body.uid, model: body.model, latencyMs: 812, status: 200 }),
    '/__admin/accounts/delete': () => ({ ok: true }),
    '/__admin/groups/set': ({ body }) => ({ ok: true, group: body.group }),
    '/__admin/schedule/run': ({ body }) => ({ ok: true, task: body.task }),
  });
  const wbPort = await listen(wb.server);

  // ── CodeArts 桩 ──
  const ca = makeStub({
    '/admin/api/overview': ({ auth }) => {
      if (auth !== 'Bearer ca-secret') { throw Object.assign(new Error('nope'), { code: 401 }); }
      return {
        accounts: [{ uid: 'c1', nickname: '华一', user_name: 'hw1', disabled: false, cooling: true,
          credits: 614.89, credit_balance: { total: 900 }, checkin_done: true, last_checkin_day: '2026-11-11',
          note: '旧备注', token_remaining: '1h', refreshable: true, credential_type: 'oauth', last_error: '' }],
        stats: { total: 1, healthy: 1, cooling: 1, credits: 614.89 },
        region: 'cn', service: 'codearts2api-panel', uptime_sec: 100, started_at: '2026-11-11T00:00:00Z',
        models: [{ id: 'm1' }], schedule: {},
      };
    },
    '/admin/api/models': () => ({ data: [{ id: 'deepseek-v4.1-flash' }] }),
    '/admin/api/logs': () => ({ entries: [{ ts: '2026-11-11T22:00:00Z', ch: 'chat', text: 'ok status=200' }] }),
    '/admin/api/accounts/enable': ({ body }) => ({ ok: true, message: '已启用 ' + body.uid }),
    '/admin/api/accounts/disable': ({ body }) => ({ ok: true, message: '已禁用 ' + body.uid }),
    '/admin/api/accounts/clear-cooldown': ({ body }) => ({ ok: true, message: '已清冷却 ' + body.uid }),
    '/admin/api/accounts/note': ({ body }) => ({ ok: true }),
    '/admin/api/accounts/delete': () => ({ ok: true }),
    '/admin/api/checkin': ({ body }) => ({ ok: true, results: [{ uid: body.uid, ok: true, credits: 10 }] }),
    '/admin/api/credits': ({ body }) => ({ ok: true, results: [{ uid: body.uid, ok: true, credits: 615 }] }),
  });
  // 桩的 401 能力：记录 auth，由 handler 返回带状态的响应不好做，改用单独路径模拟
  const caPort = await listen(ca.server);

  // ── Loomy 桩 ──
  const lo = makeStub({
    '/api/panel/state': () => ({
      ok: true, now: 1794417290,
      totals: { accounts: 2, usable: 2, available: 623741, requests: 33, points_used: 945, tokens: 11304510, failures: 0 },
      config: {},
      accounts: [
        { name: '18586545056', loginid_masked: '185****5056', enabled: true, available: 72751, balance: 67824,
          daily_balance: 4927, requests: 3, failures: 0, in_cooldown: false, banned: false, has_password: true,
          session_days_left: 4.6, expire_at: 1794818453, session: 'SECRET-SESSION-VALUE', last_error: '' },
        { name: '19030308382', enabled: false, in_cooldown: true, cooldown_seconds_left: 42, last_error: 'token=abcdefghijklmnopqrstuvwxyz012345' },
      ],
    }),
    '/api/panel/points': () => ({
      ok: true, account: '18586545056',
      overview: { daily_quota: 5000, daily_consumed: 73, daily_balance: 4927, daily_cycle_date: '2026-11-12',
        permanent_balance: 67824, invitation_codes: [{ inviteCode: 'JGA5QJ', usedCount: 9, maxUses: 20 }] },
      ledger: { total: 3542, rows: [{ created_at: 1794416598, model: 'GLM-5.3-Flash', direction: 'debit',
        points: 73, description: '扣费', source: 'daily', balance_after: 72751, cycle_date: '2026-11-12' }] },
    }),
    '/api/panel/logs': () => ({ ok: true, path: 'D:/x/gateway.log', lines: ['a', 'b', 'c'] }),
    '/api/panel/accounts/update': ({ body }) => ({ ok: true, name: body.name, state: {} }),
    '/api/panel/accounts/remove': ({ body }) => ({ ok: true, removed: body.name, state: {} }),
    '/api/panel/accounts/check': ({ body }) => ({ ok: true, checked: body.names.length, repaired: 0, failed: 0 }),
    '/api/panel/points/checkin': ({ body }) => ({ ok: true, account: body.name, already: false,
      current_balance: 5000, permanent_balance: 1, daily_balance: 2, code: 0 }),
  });
  const loPort = await listen(lo.server);

  // ── Lingxi 桩 ──
  const lx = makeStub({
    '/panel/api/overview': ({ auth }) => ({
      accounts: [{
        uid: 'x1', nickname: '灵犀一', realm: 'cn', enterprise: false, credits: 100, credits_total: 200,
        cooling: false, disabled: false, paused: true, success_count: 5, err_total: 1,
        checkin_done: true, last_success: '2026-11-11T10:00:00Z',
        credits_expiry_buckets: [{ date: '2026-12-01', expires_at: '2026-12-01T00:00:00Z', remain: 50 }],
        token_usage: { prompt: 1, completion: 2, total: 3 },
      }],
      total: 1, healthy: 1, cooling: 0, disabled: 0, paused: 1, sticky_sessions: 0,
      auth_required: true, version: '0.1.0', uptime_sec: 685, balance_refreshed_at: '2026-11-12T01:14:07Z',
      balance_refresh_sec: 300,
    }),
    '/panel/api/usage': () => ({
      totals: { requests: 1, errors: 0, prompt_tokens: 1, completion_tokens: 2, total_tokens: 3,
        credits: 0, avg_latency_ms: 10, avg_tokens_per_second: 5 },
      by_account: [{ key: 'x1', requests: 1, errors: 0, total_tokens: 3 }],
      by_model: [{ key: 'glm-5.2', requests: 1, errors: 0, total_tokens: 3 }],
      generated: '2026-11-12T01:15:33Z',
    }),
    '/panel/api/request_logs': () => ({
      entries: [{ time: '2026-11-10T21:12:38Z', path: '/v1/chat/completions', account: '-', model: 'glm-5.2',
        status: 503, outcome: 'http_error', duration_ms: 1 }],
      limit: 200,
    }),
    '/panel/api/accounts/x1/revive': () => ({ ok: true }),
    '/panel/api/accounts/x1/disable': () => ({ ok: true }),
    '/panel/api/accounts/x1/pause': () => ({ ok: true }),
    '/panel/api/accounts/x1/resume': () => ({ ok: true }),
    '/panel/api/accounts/x1/remove': () => ({ ok: true }),
    '/panel/api/accounts/x1/checkin': () => ({ ok: true, checkin_done: true, checkin_message: '' }),
    '/panel/api/accounts/x1/balance': () => ({ ok: true, credits: 150 }),
  });
  const lxPort = await listen(lx.server);

  // 平台配置：端口指向桩；凭据从桩目录的 config.json 读
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwpanel-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ admin_key: 'ca-secret', api_key: 'lx-secret', api_keys: ['lo-secret'] }));
  // 空密钥目录：三家网关未配密钥时对本机放行，不能因为「找不到 key」就判定不可用
  const tmpNoKey = fs.mkdtempSync(path.join(os.tmpdir(), 'gwpanel-nokey-'));
  fs.writeFileSync(path.join(tmpNoKey, 'config.json'), JSON.stringify({ admin_key: '', api_key: '', api_keys: [] }));

  const platforms = {
    workbuddy: { id: 'workbuddy', name: 'WorkBuddy2API', port: wbPort, enabled: true, run: {} },
    codearts: { id: 'codearts', name: 'CodeArts', port: caPort, enabled: true, workDir: tmp, run: {} },
    loomy: { id: 'loomy', name: 'Loomy', port: loPort, enabled: true, workDir: tmp, run: {} },
    lingxi: { id: 'lingxi', name: 'Lingxi', port: lxPort, enabled: true, workDir: tmp, run: {} },
    sub2api: { id: 'sub2api', name: 'Sub', port: 1, enabled: true, run: {} },
  };
  const panel = new GatewayPanel({ getPlatform: (id) => platforms[id], timeoutMs: 4000 });

  try {
    // ── WorkBuddy 只读 ──
    const d = await panel.detail('workbuddy');
    assert.equal(d.accounts.accounts.length, 2);
    assert.equal(d.accounts.accounts[0].id, 'u1');
    assert.equal(d.accounts.accounts[0].enabled, true);
    assert.equal(d.accounts.accounts[1].enabled, false);
    assert.equal(d.accounts.accounts[1].disabledReason, '12153 session dead');
    assert.equal(d.accounts.accounts[0].lastCall.ok, true);
    assert.equal(d.stats.totalRequests, 754);
    assert.equal(d.stats.statusCounts['200'], 700);
    assert.equal(d.groups.groups.u1, '可用真号');
    assert.equal(d.schedule.tasks[0].key, 'checkin');
    // 敏感字段绝不能出现在响应里
    assert.equal(JSON.stringify(d).includes('never-return'), false);
    assert.equal(JSON.stringify(d).includes('eyJhbG'), false, 'tokenHint 也必须过滤');

    // ── CodeArts 鉴权 + 视图 ──
    const c = await panel.detail('codearts');
    assert.equal(c.accounts.accounts.length, 1);
    assert.equal(c.accounts.accounts[0].note, '旧备注');
    assert.equal(c.accounts.accounts[0].credits, 614.89);
    assert.equal(c.accounts.accounts[0].creditTotal, 900);
    assert.equal(c.accounts.accounts[0].enabled, true);
    assert.equal(c.accounts.stats.healthy, 1);
    assert.equal(c.models.models[0].id, 'deepseek-v4.1-flash');
    assert.equal(JSON.stringify(c).includes('ca-secret'), false, '管理密钥不得外传');
    // 每次请求都带 Bearer
    assert.ok(ca.calls.every((x) => x.auth === 'Bearer ca-secret'));

    // ── Loomy ──
    const l = await panel.detail('loomy');
    assert.equal(l.accounts.accounts.length, 2);
    assert.equal(l.accounts.accounts[0].available, 72751);
    assert.equal(l.accounts.accounts[1].inCooldown, true);
    assert.equal(l.points.dailyQuota, 5000);
    assert.equal(l.points.recent.length, 1);
    const lJS = JSON.stringify(l);
    assert.equal(lJS.includes('SECRET-SESSION-VALUE'), false, 'session 不得外传');
    assert.equal(lJS.includes('abcdefghijklmnopqrstuvwxyz012345'), false, '上游错误必须脱敏');
    assert.ok(lo.calls.every((x) => x.auth === 'Bearer lo-secret'));

    // ── Lingxi ──
    const x = await panel.detail('lingxi');
    assert.equal(x.accounts.accounts.length, 1);
    assert.equal(x.accounts.accounts[0].paused, true);
    assert.equal(x.accounts.accounts[0].checkinDone, true);
    assert.equal(x.usage.totals.totalTokens, 3);
    assert.ok(lx.calls.every((c2) => c2.auth === 'Bearer lx-secret'));

    // ── 日志 ──
    assert.deepEqual((await panel.logs('workbuddy')).lines, ['l1', 'l2']);
    assert.match((await panel.logs('codearts')).lines[0], /\[chat\].*status=200/);
    assert.deepEqual((await panel.logs('loomy', { lines: 2 })).lines, ['b', 'c']);
    assert.match((await panel.logs('lingxi')).lines[0], /503/);

    // ── 动作：参数校验 ──
    // enabled 只认布尔语义：传 "yes" 视为启用（!== false），绝不下传原始字符串
    const toggled = await panel.action('workbuddy', 'account-toggle', { id: 'u1', enabled: 'yes' });
    assert.equal(toggled.enabled, true);
    let toggleBody = wb.calls.filter((c2) => c2.path === '/__admin/accounts/toggle').at(-1).body;
    assert.equal(toggleBody.disabled, false);
    assert.equal(typeof toggleBody.disabled, 'boolean', '下传的必须是布尔，不能是原始字符串');
    await panel.action('workbuddy', 'account-toggle', { id: 'u1', enabled: false });
    assert.deepEqual(wb.calls.filter((c2) => c2.path === '/__admin/accounts/toggle').at(-1).body,
      { uid: 'u1', disabled: true });
    await assert.rejects(panel.action('workbuddy', 'account-toggle', {}), /账号标识无效/);
    // 移除：文件名必须由后台按 uid 反查，调用方塞路径无效
    const removed = await panel.action('workbuddy', 'account-remove', { id: 'u1', file: '../evil.json' });
    assert.equal(removed.removed, true);
    assert.deepEqual(wb.calls.filter((c2) => c2.path === '/__admin/accounts/delete').at(-1).body,
      { file: 'a.json' }, '必须用后台反查到的文件名，不能采信调用方传的 file');
    await assert.rejects(panel.action('workbuddy', 'account-remove', { id: 'nope' }), /未找到该账号的凭证文件/);

    // 原型链动作必须被挡：constructor/toString 会命中 Object.prototype
    for (const evil of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      await assert.rejects(panel.action('workbuddy', evil, {}), /不支持/, `动作 ${evil} 必须被拒绝`);
    }
    await assert.rejects(panel.action('workbuddy', 'nope', {}), /不支持/);
    await assert.rejects(panel.action('sub2api', 'account-toggle', { id: 'x' }), /不支持/);
    await assert.rejects(panel.action('missing', 'account-toggle', { id: 'x' }), /未知平台/);

    // 测试连接固定用便宜模型，避免烧额度
    await panel.action('workbuddy', 'account-test', { id: 'u1' });
    const testBody = wb.calls.filter((c2) => c2.path === '/__admin/accounts/test').at(-1).body;
    assert.equal(testBody.model, 'deepseek-v4.1-flash');
    assert.equal(testBody.uid, 'u1');

    // 签到走排程任务，不接受任意账号 uid
    await panel.action('workbuddy', 'checkin', { id: 'u1' });
    assert.deepEqual(wb.calls.filter((c2) => c2.path === '/__admin/schedule/run').at(-1).body, { task: 'checkin' });

    // 分组名注入拦截
    await assert.rejects(panel.action('workbuddy', 'group-set', { id: 'u1', group: 'a/b' }), /分组名无效/);
    await panel.action('workbuddy', 'group-set', { id: 'u1', group: '可用真号' });

    // ── CodeArts 动作 ──
    await panel.action('codearts', 'account-toggle', { id: 'c1', enabled: false });
    assert.deepEqual(ca.calls.filter((c2) => c2.path === '/admin/api/accounts/disable').at(-1).body, { uid: 'c1' });
    await panel.action('codearts', 'account-toggle', { id: 'c1', enabled: true });
    assert.deepEqual(ca.calls.filter((c2) => c2.path === '/admin/api/accounts/enable').at(-1).body, { uid: 'c1' });
    const ck = await panel.action('codearts', 'checkin', { id: 'c1' });
    assert.equal(ck.credits, 10);
    await assert.rejects(panel.action('codearts', 'account-note', { id: 'c1', note: 'x'.repeat(201) }), /备注过长/);
    await panel.action('codearts', 'account-note', { id: 'c1', note: '新备注' });
    assert.deepEqual(ca.calls.filter((c2) => c2.path === '/admin/api/accounts/note').at(-1).body, { uid: 'c1', note: '新备注' });

    // ── Loomy 动作 ──
    await panel.action('loomy', 'account-toggle', { id: '18586545056', enabled: false });
    assert.deepEqual(lo.calls.filter((c2) => c2.path === '/api/panel/accounts/update').at(-1).body,
      { name: '18586545056', enabled: false });
    const loCk = await panel.action('loomy', 'checkin', { id: '18586545056' });
    assert.equal(loCk.balance, 5000);
    const loChk = await panel.action('loomy', 'account-check', { id: '18586545056' });
    assert.equal(loChk.checked, 1);
    assert.deepEqual(lo.calls.filter((c2) => c2.path === '/api/panel/accounts/check').at(-1).body,
      { names: ['18586545056'] });

    // ── Lingxi 动作（uid 走 path，必须编码） ──
    await panel.action('lingxi', 'account-toggle', { id: 'x1', enabled: false });
    assert.equal(lx.calls.filter((c2) => c2.path === '/panel/api/accounts/x1/disable').length, 1);
    await panel.action('lingxi', 'account-pause', { id: 'x1', paused: true });
    assert.equal(lx.calls.filter((c2) => c2.path === '/panel/api/accounts/x1/pause').length, 1);
    const lxCk = await panel.action('lingxi', 'checkin', { id: 'x1' });
    assert.equal(lxCk.done, true);
    // 路径注入：uid 在入口就被拒绝，请求根本不会发出
    for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b']) {
      await assert.rejects(panel.action('lingxi', 'account-toggle', { id: bad, enabled: false }),
        /账号标识无效/, `uid ${JSON.stringify(bad)} 必须在入口被拒绝`);
    }
    // '..' 是真实逃逸：encodeURIComponent('..') 不变，而 URL 构造会把
    // '/panel/api/accounts/../disable' 规范化成 '/panel/api/disable'
    assert.equal(new URL('/panel/api/accounts/' + encodeURIComponent('..') + '/disable',
      'http://127.0.0.1:6789').pathname, '/panel/api/disable',
      '这条断言记录了必须拦掉 ".." 的原因');
    assert.equal(lx.calls.some((c2) => /evil|\/panel\/api\/disable$/.test(c2.path)), false,
      '不得发出被污染或被规范化的请求');

    // ── 密钥为空：网关若免鉴权放行，就不能判成失败 ──
    // Loomy 实测 api_keys 为空数组且对本机放行：这是正常配置，不是错误。
    const noKey = new GatewayPanel({
      getPlatform: (id) => ({ ...platforms[id], workDir: tmpNoKey }),
      timeoutMs: 4000,
    });
    const loNoKey = await noKey.detail('loomy');
    assert.equal(loNoKey.accounts.error, undefined, 'Loomy 空密钥应正常读取');
    assert.equal(loNoKey.accounts.accounts.length, 2);
    const beforeNoKey = lo.calls.length;
    await noKey.detail('loomy');
    assert.ok(lo.calls.slice(beforeNoKey).every((c2) => c2.auth === ''), '空密钥时不应伪造 Authorization');

    // 反过来：网关要鉴权而本地没有 key 时，必须给出「鉴权失败」而不是假装成功
    const caNoKey = await noKey.detail('codearts');
    assert.match(caNoKey.accounts.error || '', /鉴权失败/, '缺 key 被 401 拒绝时要明确说鉴权失败');

    // ── 连接失败：不可达的端口不该抛原始 ECONNREFUSED，要给人话 ──
    const dead = new GatewayPanel({ getPlatform: (id) => ({ ...platforms[id], port: 1 }), timeoutMs: 500 });
    const deadDetail = await dead.detail('workbuddy');
    // detail 对每个分区做降级，整体不抛；错误落在分区上
    assert.match(deadDetail.accounts.error || '', /无法连接|失败|超时/);

    // 调用方塞 URL 也不会被采纳：动作只认白名单字段，多出来的 url 直接丢弃
    const extra = await panel.action('workbuddy', 'account-toggle', { id: 'u1', enabled: true, url: 'http://evil.test/' });
    assert.equal(extra.enabled, true);
    const evil = wb.calls.filter((c2) => c2.path === '/__admin/accounts/toggle').at(-1);
    assert.equal(evil.body.url, undefined, '多余字段不得下传网关');

    // ── Manager API 路由（真实 http，不经过前端） ──
    const { ApiServer } = require('../src/api-server');
    const api = new ApiServer({
      store: { getPlatform: (id) => platforms[id] },
      gatewayPanel: panel,
    });
    await api.listen('127.0.0.1:0');
    const port = api.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const H = { 'X-Wanneng-Client': 'wanneng2api' };
    try {
      const r1 = await fetch(`${base}/api/platforms/workbuddy/panel`);
      assert.equal(r1.status, 200);
      assert.equal((await r1.json()).accounts.accounts.length, 2);

      const r2 = await fetch(`${base}/api/platforms/codearts/panel/logs?lines=1`);
      assert.equal(r2.status, 200);
      assert.equal((await r2.json()).lines.length, 1);

      // 写操作：带壳自定义头才放行；不带且 Origin=null 必须 403（既有 CSRF 约定）
      const noHeader = await fetch(`${base}/api/platforms/workbuddy/panel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' },
        body: JSON.stringify({ action: 'account-toggle', id: 'u1', enabled: false }),
      });
      assert.equal(noHeader.status, 403);
      const withHeader = await fetch(`${base}/api/platforms/workbuddy/panel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...H, Origin: 'null' },
        body: JSON.stringify({ action: 'account-toggle', id: 'u1', enabled: false }),
      });
      assert.equal(withHeader.status, 200);
      assert.equal((await withHeader.json()).enabled, false);

      // 不支持的平台 / 未知动作 → 400，错误信息不泄漏内部细节
      const badPlat = await fetch(`${base}/api/platforms/sub2api/panel`);
      assert.equal(badPlat.status, 400);
      const badAct = await fetch(`${base}/api/platforms/workbuddy/panel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...H },
        body: JSON.stringify({ action: 'system/shutdown' }),
      });
      assert.equal(badAct.status, 400);
      assert.equal(JSON.stringify(await badAct.json()).includes('shutdown'), false);
    } finally {
      api.server.closeAllConnections();
      await api.close();
    }

    console.log('PASS 网关管理：四家视图、密钥不进响应、动作白名单、uid 编码、脱敏、失败边界、HTTP 路由与 CSRF');
  } finally {
    for (const s of [wb.server, ca.server, lo.server, lx.server]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpNoKey, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });