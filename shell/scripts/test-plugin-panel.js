'use strict';
// 只使用隔离的本机内核桩，不连接或启停用户的服务。
const assert = require('node:assert/strict');
const http = require('node:http');
const { PluginPanel, RoutingGroups } = require('../src/magpie-adapter');
const { ApiServer } = require('../src/api-server');

async function main() {
  const pkg = '@test/auth';
  const spec = pkg + '@latest';
  const calls = [];
  // 桩里的签到状态初值：昨天签过、今天还没。调用 checkin-account 后翻成今天已领，
  // 用来验证「一键签到」是按签到结果而不是按 HTTP 成功来判定成功。
  let checkinDay = '2026-11-11';
  let checkinOutcome = 'claimed';
  const advanced = { fallback: ['other/model'], contexts: { '*': 128000 }, proxy: 'http://secret:password@localhost:8890',
    accountProxies: { alice: 'direct' }, maxConcurrency: 3, maxAccounts: 2, routing: 'balance', affinity: 'window',
    queueLimit: 12, queueWait: 19, maxRPM: 25, priceRate: 2, bestInFamily: true,
    hiddenDrawers: ['image'], billing: 'subscription', pinUpstream: true,
    // 内核编辑器每次都会带这两个：漏掉会让保存模型选择时清空它们
    modelPrefs: { m1: { effort: 'high' } }, searches: true };
  const state = { plugins: [
    { id: 'test', pid: 'test', spec, name: '测试插件', signedIn: true, methods: [{ type: 'oauth', label: '浏览器登录' }, { type: 'api', label: 'API key' }],
      options: [{ key: 'region', label: '限定区域', on: false }] },
    { id: 'test-cn', pid: 'test-cn', spec, name: '测试国内版', models: 0, methods: [{ type: 'oauth', label: '国内登录' }] },
    { id: 'other', pid: 'other', spec: '@test/other@latest', name: '其它插件', methods: [] },
  ], providers: [{ id: 'test', name: '测试插件', key: { set: true, masked: 'abc…' }, secret: 'never-return-this',
    ...advanced, models: [{ id: 'm1', on: true, name: '模型一' }, { id: 'm2', on: false }], chosen: ['m1'],
    account: { agent: 'plugin:test', logins: [{ user: 'alice', active: true, on: true, token: 'private-token' }] } },
    { id: 'other', account: { logins: [{ user: 'bob', token: 'bob-secret' }] }, models: [] },
    // 绑定测试用的平台：一个正常、一个模型全关、一个空
    { id: 'p1', name: '平台一', key: { set: true }, models: [{ id: 'chat', on: true }], chosen: ['chat'] },
    { id: 'p2', name: '平台二', key: { set: true }, models: [{ id: 'chat', on: true }, { id: 'offmodel', on: false }] },
    { id: 'empty', name: '空平台', key: { set: true }, models: [] }] };
  let mode = 'ok';
  let failSave = false;
  const stub = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      calls.push({ path: '/', cookie: req.headers.cookie });
      if (mode === 'redirect') { res.writeHead(303, { Location: 'http://example.invalid/' }); return res.end(); }
      if (mode === 'denied') { res.writeHead(401); return res.end('secret-key'); }
      if (u.searchParams.get('k') === 'test-web-key') {
        res.writeHead(303, { Location: '/', 'Set-Cookie': 'test-session=valid; HttpOnly; Path=/' }); return res.end();
      }
      res.writeHead(401); return res.end();
    }
    if (req.headers.cookie !== 'test-session=valid') { res.writeHead(401); return res.end(); }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: u.pathname, body });
    const send = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (mode === 'large') return send({ huge: 'x'.repeat(10000) });
    if (mode === 'bad') return res.end('not-json');
    if (mode === 'timeout') return;
    if (u.pathname === '/api/providers') return send(state);
    if (u.pathname === '/api/groups') {
      if (!state.groups) return send({ groups: [] });
      return send({ groups: state.groups });
    }
    if (!state.groups) {
      state.groups = [
        { id: 'auto-m1', name: 'M1', auto: true, routing: '', ready: true, ref: 'auto/m1',
          members: ['p1/m1', 'p2/m1'], note: 'n', patience: 5, levels: ['high'],
          memberInfo: [{ id: 'p1/m1', provider: 'p1', model: 'm1', ready: true }, { id: 'p2/m1', provider: 'p2', model: 'm1', ready: true }] },
        { id: 'smart-m1', name: 'S1', auto: false, routing: 'smart', members: ['p1/m1', 'p2/m1'], memberInfo: [] },
      ];
    }
    if (u.pathname === '/api/groups/save') {
      calls.push({ path: 'groups-save', body });
      if (failSave) { res.writeHead(500); return res.end('nope'); }
      state.groups = (state.groups || []).map((g) => g.id === body.id ? { ...g, auto: false, members: body.members } : g);
      if (!body.id) state.groups.push({ id: 'bound-1', name: body.name, auto: false, routing: body.routing, members: body.members, memberInfo: [] });
      return send({ groups: state.groups });
    }
    if (u.pathname === '/api/groups/delete') { calls.push({ path: 'groups-delete', body }); return send({ groups: state.groups || [] }); }
    if (u.pathname === '/api/usage/quotas') return send([
      { provider: 'test', name: '测试插件', user: 'alice', checkins: true, plan: 'Free',
        checkinBy: 'plugin:test', checkinKey: 'test|alice',
        // 上一次签到是昨天；调用 checkin-account 后置为今天已领（照真实流转）
        checkin: { day: checkinDay, outcome: checkinOutcome, credit: '+10', streak: 3,
          msg: checkinOutcome === 'ineligible' ? 'device identity runtime not found' : '' },
        windows: [
          // used 是**百分比**，amount 才是计数（内核 to100 + quotaCount 的口径）
          { name: 'Credits', used: 50, amount: 12, limit: 50, unit: 'credits', display: '12 / 50', resetsAt: '2026-12-01T00:00:00Z' },
          { name: 'No-limit', used: 100, display: '0 credits left' },
        ] },
      { provider: 'other', name: '其它', user: 'bob', checkins: true,
        checkinBy: 'plugin:other', checkinKey: 'other|bob',
        checkin: { day: '2026-11-11', outcome: 'claimed' } },
    ]);
    if (u.pathname === '/api/usage/checkin-account') {
      calls.push({ path: 'checkin-account', body });
      // 模拟上游两种真实结果：真的签成 → 今天 claimed；
      // 请求 200 但上游不给（Qoder 缺设备身份）→ 今天仍是 ineligible。
      if (body.key === 'test|alice' && checkinOutcome !== 'ineligible') {
        checkinDay = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        checkinOutcome = 'claimed';
      }
      return send({ user: body.key, outcome: checkinOutcome, credit: '+10' });
    }
    if (u.pathname === '/api/plugins') return send({ plugins: [{ spec, version: '1.2.3' }] });
    if (u.pathname === '/api/plugin-signin/prompt') {
      if (!body.key) return send({ prompt: { key: 'tenant', type: 'text', label: '企业域名', secret: false } });
      return send({ inputs: { tenant: body.value } });
    }
    if (u.pathname === '/api/plugin-signin') return send({ id: 's1', state: 'waiting', url: 'https://example.invalid/authorize', token: 'secret-oauth-token' });
    if (u.pathname === '/api/signin/s1') return send({ id: 's1', state: 'done', user: 'alice', refresh_token: 'never-return' });
    if (u.pathname === '/api/signin/s1/cancel') return send({ id: 's1', state: 'canceled' });
    if (u.pathname === '/api/provider/save') {
      if (failSave) { res.writeHead(500); return res.end('private-token'); }
      const { models, ...fields } = body;
      Object.assign(state.providers[0], fields, { chosen: models });
      state.providers[0].models.forEach((m) => { m.on = models.includes(m.id); });
      return send(state);
    }
    return send(state);
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${stub.address().port}`;
  const config = { adminPanel: origin + '/?k=test-web-key' };
  const panel = new PluginPanel({ getConfig: () => config });
  let api;
  try {
    const detail = await panel.detail(pkg, 'test');
    assert.equal(detail.accounts.length, 1);
    // 签到：只暴露本插件的账号，另一个 provider 的签到不得出现
    assert.equal(detail.checkin.supported, true);
    assert.equal(detail.checkin.accounts.length, 1);
    assert.equal(detail.checkin.accounts[0].key, 'test|alice');
    assert.equal(detail.checkin.accounts[0].outcome, 'claimed');
    assert.equal(JSON.stringify(detail.checkin).includes('other|bob'), false);
    // 上游错误文本必须脱敏：长 token 与 URL 查询参数里的密钥不能到前端
    const red = panel._redact('GET https://x.ai/cb?k=secretvalue123 failed token=abcdefghijklmnopqrstuvwxyz012345');
    assert.equal(red.includes('secretvalue123'), false);
    assert.equal(red.includes('abcdefghijklmnopqrstuvwxyz012345'), false);
    assert.equal(panel._redact('this account has no plan'), 'this account has no plan');
    // 额度：只取本 provider；有 limit 才算百分比，没有 limit 不编造
    assert.equal(detail.quota.available, true);
    assert.equal(detail.quota.plan, 'Free');
    const credits = detail.quota.windows.find((w) => w.name === 'Credits');
    // used=50 是 50%，不是 used/limit；计数看 amount
    assert.equal(credits.percent, 50, 'used 是百分比，不能再除以 limit');
    assert.equal(credits.amount, 12, '计数必须用 amount');
    assert.equal(credits.limit, 50);
    // 没有 amount 的窗口：percent 仍来自 used，但不得编造计数
    const noLimit = detail.quota.windows.find((w) => w.name === 'No-limit');
    assert.equal(noLimit.percent, 100);
    assert.equal(noLimit.amount, null);
    assert.equal(JSON.stringify(detail.quota).includes('other'), false);
    assert.equal(detail.version, '1.2.3');
    assert.equal(detail.providers.length, 2);
    const serialized = JSON.stringify(detail);
    for (const secret of ['never-return-this', 'private-token', 'bob', 'secret:password', 'test-web-key', 'test-session']) assert.equal(serialized.includes(secret), false);
    assert.equal(calls.filter((x) => x.path === '/').length, 1);
    assert.equal((await panel.detail(pkg, 'test-cn')).models.length, 0);
    await assert.rejects(panel.detail(pkg, 'other'), /不属于/);
    await assert.rejects(panel.action(pkg, 'test', 'account-remove', { user: 'bob' }), /不属于/);
    await assert.rejects(panel.action(pkg, 'test', 'anything', {}), /不支持/);
    await assert.rejects(panel.action(pkg, 'test', 'option-save', { key: 'unknown', on: true }), /选项无效/);
    await panel.action(pkg, 'test', 'option-save', { key: 'region', on: true });
    assert.deepEqual(calls.find((x) => x.path === '/api/settings/plugin-option').body, { provider: 'test', key: 'region', on: true });
    await panel.action(pkg, 'test', 'models-save', { models: ['m2'] });
    const saved = calls.find((x) => x.path === '/api/provider/save').body;
    for (const [key, value] of Object.entries(advanced)) assert.deepEqual(saved[key], value, key + ' 不得丢失');
    assert.deepEqual(saved.models, ['m2']);
    assert.equal(saved.noModels, false);
    await panel.action(pkg, 'test', 'models-save', { models: [] });
    assert.equal(calls.filter((x) => x.path === '/api/provider/save').at(-1).body.noModels, true);
    assert.deepEqual((await panel.detail(pkg, 'test')).chosen, []);
    assert.equal(Object.hasOwn(saved, 'key'), false);
    await assert.rejects(panel.action(pkg, 'test', 'models-save', { models: ['other/model'] }), /模型选择无效/);
    failSave = true;
    await assert.rejects(panel.action(pkg, 'test', 'models-save', { models: ['m1'] }), /HTTP 500/);
    failSave = false;
    const prompt = await panel.action(pkg, 'test', 'signin-prompt', { method: 0, inputs: {} });
    assert.equal(prompt.prompt.key, 'tenant');
    const passwordPrompt = panel._prompt({ prompt: { key: 'token', type: 'password', message: 'Token',
      messages: { zh: '登录令牌' }, options: [{ value: 'one', label: 'One', labels: { zh: '选项一' } }] } });
    assert.equal(passwordPrompt.prompt.secret, true);
    assert.equal(passwordPrompt.prompt.messages.zh, '登录令牌');
    assert.equal(passwordPrompt.prompt.options[0].labels.zh, '选项一');
    const answer = await panel.action(pkg, 'test', 'signin-prompt', { method: 0, inputs: {}, key: 'tenant', value: 'team' });
    assert.equal(answer.inputs.tenant, 'team');
    const signin = await panel.action(pkg, 'test', 'signin-start', { method: 0, inputs: answer.inputs });
    assert.equal(signin.id, 's1');
    assert.equal(JSON.stringify(signin).includes('secret-oauth-token'), false);
    await assert.rejects(panel.action(pkg, 'test-cn', 'signin-status', { id: 's1' }), /不属于/);
    assert.equal((await panel.action(pkg, 'test', 'signin-status', { id: 's1' })).state, 'done');
    assert.equal((await panel.action(pkg, 'test', 'signin-cancel', { id: 's1' })).state, 'canceled');
    await assert.rejects(panel.action(pkg, 'test', 'signin-status', { id: 's1' }), /不属于/);
    for (const action of ['account-off', 'account-on', 'account-remove']) await panel.action(pkg, 'test', action, { user: 'alice' });
    for (const op of ['off', 'on', 'forget']) assert.deepEqual(calls.find((x) => x.path === '/api/login/' + op).body, { agent: 'plugin:test', user: 'alice' });
    await panel.action(pkg, 'test', 'models-refresh');
    assert.deepEqual(calls.find((x) => x.path === '/api/provider/models').body, { id: 'test' });
    // 启用/禁用：不接受非布尔，且 id 由后台按插件解析后下发
    await assert.rejects(panel.action(pkg, 'test', 'provider-toggle', { on: 'yes' }), /开关状态无效/);
    await panel.action(pkg, 'test', 'provider-toggle', { on: false });
    assert.deepEqual(calls.find((x) => x.path === '/api/provider/off').body, { id: 'test' });
    await panel.action(pkg, 'test', 'provider-toggle', { on: true });
    assert.deepEqual(calls.find((x) => x.path === '/api/provider/on').body, { id: 'test' });
    // 签到：必须是本插件账号，且 by/key 由后台决定，不能由前端伪造
    await assert.rejects(panel.action(pkg, 'test', 'checkin', { key: 'other|bob' }), /不属于/);
    const checked = await panel.action(pkg, 'test', 'checkin', { key: 'test|alice' });
    assert.equal(checked.checkin.accounts.length, 1);
    assert.deepEqual(calls.find((x) => x.path === 'checkin-account').body, { by: 'plugin:test', key: 'test|alice' });
    // 一键签到：只签本插件账号（其它 provider 的账号不参与），结果如实回报
    const beforeBulk = calls.filter((x) => x.path === 'checkin-account').length;
    const all = await panel.action(pkg, 'test', 'checkin-all', {});
    const bulk = calls.filter((x) => x.path === 'checkin-account').slice(beforeBulk);
    assert.deepEqual(bulk.map((x) => x.body.key), ['test|alice']);
    assert.deepEqual(bulk.map((x) => x.body.by), ['plugin:test']);
    assert.equal(all.checkinAll.count, 1);
    assert.equal(all.checkinAll.succeeded, 1);
    assert.equal(all.checkinAll.failed, 0);

    // 请求 200 但上游根本没给（Qoder 缺设备身份 → ineligible）必须算失败，
    // 否则一键签到会撒谎说「全部成功」。
    checkinDay = '2026-11-11';
    checkinOutcome = 'ineligible';
    const all2 = await panel.action(pkg, 'test', 'checkin-all', {});
    assert.equal(all2.checkinAll.succeeded, 0, 'ineligible 不能算签到成功');
    assert.equal(all2.checkinAll.failed, 1);
    assert.match(all2.checkinAll.failures[0].message, /device identity runtime not found/);
    checkinOutcome = 'claimed';
    // 路由组排序：只能重排现有成员，且必须原样回传其它字段
    const routing = new RoutingGroups({ getConfig: () => config });
    const shared = await routing.shared();
    assert.equal(shared.length, 2);
    const reordered = await routing.reorder('auto-m1', ['p2/m1', 'p1/m1']);
    assert.deepEqual(reordered.members, ['p2/m1', 'p1/m1']);
    const savedBody = calls.filter((x) => x.path === 'groups-save').at(-1).body;
    assert.equal(savedBody.note, 'n');
    assert.equal(savedBody.patience, 5);
    assert.deepEqual(savedBody.levels, ['high']);
    assert.equal(savedBody.from, 'auto-m1');
    // 关键：内核的 routing 空值 = 智能路由，绝不能被改写成 order
    assert.equal(savedBody.routing, '', '空 routing（智能）必须原样回传，不能变成 order');
    assert.equal(typeof savedBody.sink, 'boolean', 'sink 必须是布尔（内核契约）');
    await assert.rejects(routing.reorder('auto-m1', ['p1/m1']), /只能调整现有成员/);
    await assert.rejects(routing.reorder('auto-m1', ['p1/m1', 'p1/m1']), /只能调整现有成员/);
    await assert.rejects(routing.reorder('auto-m1', ['p1/m1', 'p9/m1']), /只能调整现有成员/);
    await assert.rejects(routing.reorder('smart-m1', ['p2/m1', 'p1/m1']), /成员顺序不影响路由/);
    await assert.rejects(routing.reorder('missing', ['a', 'b']), /不存在/);

    // Hub 绑定：只允许已安装 provider，成员由后台展开，不能由前端塞任意 id
    const bindable = await routing.bindable();
    // test/other/p1/p2/empty 都是已安装 provider（test 与 other 也参与）
    assert.equal(bindable.length, 5);
    assert.ok(bindable.some((b) => b.id === 'p1'));
    assert.ok(bindable.some((b) => b.id === 'p2'));
    assert.equal(bindable.find((b) => b.id === 'p2').models.length, 1); // 只列已启用模型
    const bound = await routing.bind({ name: '我的入口', providers: ['p1', 'p2'] });
    assert.deepEqual(bound.members, ['p1/chat', 'p2/chat']);
    const bindBody = calls.filter((x) => x.path === 'groups-save').at(-1).body;
    assert.equal(bindBody.routing, 'order');
    assert.equal(bindBody.name, '我的入口');
    await assert.rejects(routing.bind({ name: '', providers: ['p1'] }), /名称无效/);
    await assert.rejects(routing.bind({ name: 'x', providers: [] }), /至少选择/);
    await assert.rejects(routing.bind({ name: 'x', providers: ['nope'] }), /不存在/);
    await assert.rejects(routing.bind({ name: 'x', providers: ['empty'] }), /没有已启用的模型/);
    // 安全回归：带 id 不得覆盖内核自动合并的组，也不得指向不存在的组
    await assert.rejects(routing.bind({ id: 'auto-m1', name: 'x', providers: ['p1'] }), /自动合并|不能在此覆盖/);
    await assert.rejects(routing.bind({ id: 'nope', name: 'x', providers: ['p1'] }), /不存在/);
    // 更新既有组：必须保留原 note/rules/weights，不能被默认空值抹掉
    state.groups.push({ id: 'mine', name: '我的组', auto: false, routing: 'order',
      members: ['p1/chat'], note: '原备注', patience: 7, weights: { 'p1/chat': 3 }, rules: [{ when: 'night' }] });
    await routing.bind({ id: 'mine', name: '我的组', providers: ['p1'] });
    const upd = calls.filter((x) => x.path === 'groups-save').at(-1).body;
    assert.equal(upd.note, '原备注', '更新时必须保留原 note');
    assert.equal(upd.patience, 7);
    assert.deepEqual(upd.weights, { 'p1/chat': 3 });
    assert.deepEqual(upd.rules, [{ when: 'night' }]);

    const apiPanel = new PluginPanel({ getConfig: () => config });
    api = new ApiServer({ store: { getPlatform: () => config }, pluginPanel: apiPanel });
    await api.listen('127.0.0.1:0');
    const url = `http://127.0.0.1:${api.server.address().port}/api/magpie/plugin-panel`;
    const res = await fetch(url + '?' + new URLSearchParams({ package: pkg, provider: 'test' }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).provider, 'test');
    const wrong = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: pkg, provider: 'other', action: 'account-remove', user: 'bob' }) });
    assert.equal(wrong.status, 400);
    await assert.rejects(new PluginPanel({ getConfig: () => ({ adminPanel: 'http://example.invalid/' }) }).detail(pkg, 'test'), /仅允许/);
    mode = 'redirect';
    await assert.rejects(new PluginPanel({ getConfig: () => config }).detail(pkg, 'test'), /跨站/);
    mode = 'denied';
    await assert.rejects(new PluginPanel({ getConfig: () => config }).detail(pkg, 'test'), /鉴权失败/);
    mode = 'bad';
    await assert.rejects(panel.detail(pkg, 'test'), /不兼容/);
    mode = 'large';
    const small = new PluginPanel({ getConfig: () => config, maxBytes: 1000 });
    await assert.rejects(small.detail(pkg, 'test'), /响应过大|响应中断/);
    mode = 'timeout';
    await assert.rejects(new PluginPanel({ getConfig: () => config, timeoutMs: 50 }).detail(pkg, 'test'), /超时/);
    console.log('PASS 插件面板：会话鉴权、脱敏、多 provider、操作归属、动态登录、保存保留配置、HTTP 路由与错误边界');
  } finally {
    if (api) { api.server.closeAllConnections(); await api.close(); }
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
