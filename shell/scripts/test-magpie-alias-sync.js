'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MagpieAliasSync, AliasStateStore, defaultState, readCallerKeys, keyEligibility,
  buildPlan, mergePlan, safeGroupTarget, aliasOf,
} = require('../src/magpie-alias-sync');

const KEY_ID = 'a'.repeat(24);
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (id, models, extra = {}) => ({
  id, name: id, ready: true, off: false,
  models: models.map((id) => ({ id, on: true })), ...extra,
});
const key = (models = [], aliases = {}, extra = {}) => ({
  id: KEY_ID, name: 'Magpie', secret: 'fixture-secret-do-not-return',
  models, aliases, ...extra,
});

function fixture({ providers, groups = [], keys = [key()], onRefresh, onWrite } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-alias-sync-'));
  const dataDir = path.join(root, 'data');
  const magpieDir = path.join(root, 'magpie');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(magpieDir, { recursive: true });
  const callerFile = path.join(magpieDir, 'caller-keys.json');
  const writeKeys = () => fs.writeFileSync(callerFile, JSON.stringify(keys, null, 2));
  writeKeys();
  const calls = [];
  const panel = {
    async _api(endpoint, body) {
      if (endpoint === 'providers') return { providers: clone(providers) };
      if (endpoint === 'provider/models') {
        calls.push({ action: 'refresh', id: body.id });
        const index = providers.findIndex((p) => p.id === body.id);
        if (index < 0) throw new Error('provider not found');
        const next = onRefresh ? onRefresh(body.id, clone(providers[index])) : clone(providers[index]);
        providers[index] = next;
        return { provider: clone(next) };
      }
      throw new Error(`unexpected api ${endpoint}`);
    },
    async callerKey(action, keyId, change) {
      const target = keys.find((k) => k.id === keyId);
      if (!target) throw new Error('key not found');
      calls.push({ action, keyId, ...clone(change || {}) });
      if (onWrite) await onWrite(action, target, change);
      if (action === 'models-key') target.models = [...change.models].sort((a, b) => a.localeCompare(b));
      else if (action === 'aliases-key') {
        target.aliases = Object.fromEntries(Object.entries(change.aliases).sort(([a], [b]) => a.localeCompare(b)));
      } else if (action === 'off-key') target.off = true;
      else if (action === 'on-key') target.off = false;
      writeKeys();
      return {};
    },
  };
  const sync = new MagpieAliasSync({
    dataDir, magpieDir, store: {}, updater: { syncProviderKey: async () => ({ ok: true, unchanged: true }) },
    panel, routingGroups: { raw: async () => clone(groups) }, debounceMs: 0,
  });
  return {
    root, sync, calls, providers, groups, keys, callerFile,
    readKey: () => readCallerKeys(callerFile).find((k) => k.id === KEY_ID),
    readState: () => new AliasStateStore(path.join(dataDir, 'alias-sync.json')).read(),
    cleanup: async () => { await sync.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

async function testStateAndEligibility() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-alias-state-'));
  try {
    const store = new AliasStateStore(path.join(root, 'alias-sync.json'));
    assert.strictEqual(store.read().selectedKeyId, '');
    fs.writeFileSync(store.file, '{broken');
    assert.throws(() => store.read(), /损坏/);
    assert.strictEqual(keyEligibility(key()).eligible, true);
    for (const extra of [{ lan: true }, { off: true }, { readOnly: true }, { browser: true }, { issuer: 'parent' }, { expires: '2020-01-01' }]) {
      assert.strictEqual(keyEligibility(key([], {}, extra)).eligible, false);
    }
    assert.strictEqual(aliasOf('cline-pass/glm-5.3-flash'), 'glm-5.3-flash');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testPlanner() {
  const providers = [row('a', ['glm', 'solo']), row('b', ['glm']), row('c', ['glm'])];
  const groups = [{ id: 'auto-glm', name: 'glm', auto: true, ref: 'auto/glm', members: ['a/glm', 'b/glm'], patterns: [] }];
  const planned = buildPlan({
    key: key(), providers, groups, authorizedProviderIds: ['a', 'b'], providerCache: {},
  });
  assert.strictEqual(planned.desiredAliases.get('glm').target, 'auto/glm');
  assert.strictEqual(planned.desiredAliases.get('solo').target, 'a/solo');
  assert(planned.desiredModels.has('auto/glm'));

  const unsafe = safeGroupTarget({ ...groups[0], members: ['a/glm', 'b/glm', 'c/glm'] }, 'glm', ['a/glm', 'b/glm'], KEY_ID);
  assert.strictEqual(unsafe.ok, false, '组内含未授权成员时不能使用');
  assert.strictEqual(safeGroupTarget({ ...groups[0], keys: ['other-key'] }, 'glm', ['a/glm', 'b/glm'], KEY_ID).ok, false);
  assert.strictEqual(safeGroupTarget({ ...groups[0], patterns: [{ pattern: 'a/*' }] }, 'glm', ['a/glm', 'b/glm'], KEY_ID).ok, false);

  const noGroup = buildPlan({ key: key(), providers, groups: [], authorizedProviderIds: ['a', 'b'], providerCache: {} });
  assert(noGroup.conflicts.some((c) => c.code === 'group-required'));
  assert.strictEqual(noGroup.desiredAliases.has('glm'), false, '冲突不能回退第一家');
  assert.strictEqual(noGroup.desiredAliases.get('solo').target, 'a/solo');

  const state = { ...defaultState(), authorizedProviderIds: ['a'], adoptedProviderIds: ['a'],
    managed: { models: ['a/solo'], aliases: { solo: 'a/solo' }, groups: {} } };
  const merged = mergePlan({
    key: key(['a/solo', 'other/x'], { solo: 'b/changed', manual: 'other/x' }), state,
    planned: {
      desiredModels: new Map([['a/solo', 'a/solo']]),
      desiredAliases: new Map([['solo', { name: 'solo', target: 'a/solo' }]]),
      groupSnapshots: {}, conflicts: [],
    },
  });
  assert.strictEqual(merged.aliases.solo, 'b/changed', '外部修改的 alias 必须保留');
  assert.strictEqual(merged.aliases.manual, 'other/x');
  assert(merged.conflicts.some((c) => c.code === 'external-alias'));
  assert(merged.models.includes('other/x'));

  const unrestricted = mergePlan({
    key: key([], {}), state,
    planned: {
      desiredModels: new Map([['a/solo', 'a/solo']]), desiredAliases: new Map(),
      groupSnapshots: {}, conflicts: [],
    },
  });
  assert(unrestricted.conflicts.some((c) => c.code === 'models-unrestricted' && c.fatal));

  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`m${i}`, 'other/x']));
  const limited = mergePlan({
    key: key(['other/x'], many), state: { ...state, managed: { models: [], aliases: {}, groups: {} }, authorizedProviderIds: [] },
    planned: { desiredModels: new Map(), desiredAliases: new Map(), groupSnapshots: {}, conflicts: [] },
  });
  assert(limited.conflicts.some((c) => c.code === 'native-limit' && c.fatal));
}

async function testStaleRefreshAdoptionAndRevoke() {
  const current = [
    'kimi-k3.1-pro', 'qwen3.8_max', 'deepseek-v4-pro-0813', 'glm-5.3-flash', 'deepseek-v4-flash',
    'glm-5.3', 'glm-5.2', 'hy4-preview', 'hy3', 'minimax-m3', 'kimi-k2.7',
  ];
  const stale = [
    'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex',
    'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7', 'old-8', 'old-9',
  ];
  const old = [...current, ...stale];
  assert.strictEqual(old.length, 27);
  const oldAliases = Object.fromEntries(old.map((id) => [id, `wanneng-lingxi/${id}`]));
  oldAliases.custom = 'other/manual';
  const f = fixture({
    providers: [row('wanneng-lingxi', old), row('other', ['manual'])],
    keys: [key(['wanneng-lingxi/*', 'other/manual'], oldAliases)],
    onRefresh: (id) => id === 'wanneng-lingxi' ? row(id, current) : row(id, ['manual']),
  });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('wanneng-lingxi', true);
    await f.sync.flush();
    const actual = f.readKey();
    const aliases = actual.aliases;
    assert.strictEqual(Object.keys(aliases).length, 12, '11 个真实模型 + 1 个手工 alias');
    assert.deepStrictEqual(Object.keys(aliases).filter((id) => id.startsWith('gpt-')), [], '旧 GPT aliases 必须消失');
    assert.strictEqual(aliases['kimi-k3.1-pro'], 'wanneng-lingxi/kimi-k3.1-pro');
    assert.strictEqual(aliases.custom, 'other/manual', '无关手工 alias 保留');
    assert(!actual.models.includes('wanneng-lingxi/*'), '授权后 provider/* 收敛为明确模型');
    assert(actual.models.includes('other/manual'));
    assert.strictEqual(actual.models.length, 12);
    assert.deepStrictEqual(f.readState().adoptedProviderIds, ['wanneng-lingxi']);
    assert(!JSON.stringify(await f.sync.status()).includes('fixture-secret-do-not-return'));
    assert(!fs.readFileSync(path.join(f.root, 'data', 'alias-sync.json'), 'utf8').includes('fixture-secret-do-not-return'));

    const writesBefore = f.calls.filter((c) => ['models-key', 'aliases-key'].includes(c.action)).length;
    await f.sync.runNow();
    const writesAfter = f.calls.filter((c) => ['models-key', 'aliases-key'].includes(c.action)).length;
    assert.strictEqual(writesAfter, writesBefore, '相同目录重复同步应幂等');

    await f.sync.setProvider('wanneng-lingxi', false);
    await f.sync.flush();
    assert.strictEqual(f.readKey().off, false, '仍有手工权限时不能误禁用整个 Key');
    assert.deepStrictEqual(Object.keys(f.readKey().aliases), ['custom'], '撤销只清理同步器托管 aliases');
    assert.deepStrictEqual(f.readKey().models, ['other/manual'], '撤销后仅保留手工模型权限');
    assert(f.calls.every((c) => c.action !== 'models-key' || c.models.length > 0));

    await f.sync.setProvider('wanneng-lingxi', true);
    await f.sync.flush();
    assert.strictEqual(f.readKey().off, false, '只能自动重新启用同步器自己禁用的 Key');
  } finally { await f.cleanup(); }
}

async function testFailedRefreshKeepsCache() {
  let fail = false;
  const f = fixture({
    providers: [row('local', ['one', 'two'])],
    keys: [key(['local/*'], {})],
    onRefresh: (id, current) => {
      if (fail) throw new Error('temporary upstream failure');
      return current;
    },
  });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('local', true);
    await f.sync.flush();
    assert.deepStrictEqual(Object.keys(f.readKey().aliases).sort(), ['one', 'two']);
    fail = true;
    await f.sync.runNow();
    assert.deepStrictEqual(Object.keys(f.readKey().aliases).sort(), ['one', 'two'], '刷新失败不能把旧模型当成全部删除');
    assert(f.readState().conflicts.some((c) => c.code === 'provider-models-stale'));
  } finally { await f.cleanup(); }
}

async function testRevisionDuringWrite() {
  let release;
  let modelsStarted;
  const started = new Promise((resolve) => { modelsStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    providers: [row('local', ['one'])], keys: [key(['local/*'], {})],
    onWrite: async (action) => {
      if (action === 'models-key') { modelsStarted(); await gate; }
    },
  });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('local', true);
    f.sync.start();
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`等待 models-key 超时：${JSON.stringify(f.calls)}`)), 1000)),
    ]);
    await f.sync.setProvider('local', false);
    release();
    await f.sync.flush();
    assert.strictEqual(f.readKey().off, true, `撤销代次必须清理写入途中完成的 Models：${JSON.stringify({ key: f.readKey(), state: f.readState(), calls: f.calls })}`);
    assert.strictEqual(f.readState().disabledBySync, true);
    await f.sync.setProvider('local', true);
    await f.sync.flush();
    assert.strictEqual(f.readKey().off, false, '恢复授权后才能重新启用同步器禁用的 Key');
  } finally { release(); await f.cleanup(); }
}

async function testManualPermissionsAndCrashRecovery() {
  for (const extra of [{ aliases: { manual: 'other/manual' }, accounts: [] }, { aliases: {}, accounts: ['local/account'] }]) {
    const f = fixture({
      providers: [row('local', ['one'])],
      keys: [key(['local/*'], extra.aliases, { accounts: extra.accounts })],
    });
    try {
      await f.sync.selectKey(KEY_ID);
      await f.sync.setProvider('local', true);
      await f.sync.flush();
      await f.sync.setProvider('local', false);
      await assert.rejects(f.sync.flush(), /手工 aliases 或 Accounts/);
      assert.strictEqual(f.readKey().off, false, `有手工配置时绝不能误禁用 Key：${JSON.stringify(extra)}`);
      assert(f.readKey().models.length > 0, '不能为了撤销而写 Models 空数组');
    } finally { await f.cleanup(); }
  }

  const crashed = { ...defaultState(), authorizedProviderIds: ['a'], adoptedProviderIds: ['a'],
    pendingWrite: { managedModels: ['a/solo'], managedAliases: { solo: 'a/solo' }, groups: {} } };
  const recovered = mergePlan({
    key: key(['a/solo'], { solo: 'a/solo' }), state: crashed,
    planned: { desiredModels: new Map(), desiredAliases: new Map(), groupSnapshots: {}, conflicts: [] },
  });
  assert.deepStrictEqual(recovered.models, [], '崩溃前已写入的 pending Models 必须可撤销');
  assert.deepStrictEqual(recovered.aliases, {}, '崩溃前已写入的 pending aliases 必须可撤销');

  const retry = mergePlan({
    key: key(['other/x'], {}), state: crashed,
    planned: {
      desiredModels: new Map([['a/solo', 'a/solo']]),
      desiredAliases: new Map([['solo', { name: 'solo', target: 'a/solo' }]]),
      groupSnapshots: {}, conflicts: [],
    },
  });
  assert(retry.models.includes('a/solo'), 'pending 未实际写入时必须允许重试');
  assert.strictEqual(retry.aliases.solo, 'a/solo');
  assert(!retry.conflicts.some((c) => c.code.startsWith('external-')));
}

async function testConcurrentMutations() {
  const f = fixture({ providers: [row('a', ['one']), row('b', ['two'])], keys: [key(['a/*', 'b/*'], {})] });
  try {
    await f.sync.selectKey(KEY_ID);
    await Promise.all([f.sync.setProvider('a', true), f.sync.setProvider('b', true)]);
    await assert.rejects(f.sync.selectKey('b'.repeat(24)), /同步进行中/);
    await f.sync.flush();
    assert.deepStrictEqual(f.readState().authorizedProviderIds, ['a', 'b'], '并发授权不能丢 provider');
    assert.deepStrictEqual(Object.keys(f.readKey().aliases).sort(), ['one', 'two']);
    await Promise.all([f.sync.setProvider('a', false), f.sync.setProvider('b', false)]);
    await f.sync.flush();
    assert.deepStrictEqual(f.readState().authorizedProviderIds, [], '并发撤销不能复活 provider');
    assert.strictEqual(f.readKey().off, true, '无手工权限的最后撤销应禁用');
  } finally { await f.cleanup(); }
}

async function testOwnedModelRefreshWithoutAliases() {
  const stale = ['gpt-6-astra', 'gpt-5.5', 'kimi-k2.7', 'glm-5.2', 'glm-5.3'];
  const current = ['glm-5.2', 'glm-5.3', 'kimi-k3.1-pro', 'qwen3.8_max'];
  const f = fixture({
    providers: [row('wanneng-lingxi', stale), row('wanneng-workbuddy', ['hy3'])],
    keys: [key([], {})],
    onRefresh: (id, currentRow) => id === 'wanneng-lingxi' ? row(id, current) : currentRow,
  });
  try {
    // 未选择 Key、未授权任何 provider，启动同步仍必须刷新模型目录。
    await f.sync.runNow({ refresh: true });
    const refreshed = f.calls.filter((c) => c.action === 'refresh').map((c) => c.id);
    assert(refreshed.includes('wanneng-lingxi'), '未授权 aliases 时也必须刷新自建 provider 模型');
    assert(refreshed.includes('wanneng-workbuddy'));
    assert(!f.calls.some((c) => ['models-key', 'aliases-key'].includes(c.action)), '仅刷新模型不得写 caller-key');
    const lingxi = f.providers.find((p) => p.id === 'wanneng-lingxi');
    assert(!lingxi.models.some((m) => /^gpt-/.test(m.id)), '旧 GPT 模型必须被新快照替换');
    assert(lingxi.models.some((m) => m.id === 'kimi-k3.1-pro'), '上游新增模型必须进入 magpie 目录');
    const cache = f.readState().providers['wanneng-lingxi'];
    assert(cache.models.includes('kimi-k3.1-pro'));
    assert(!cache.models.includes('gpt-5.5'));
    assert.strictEqual(f.readKey().models.length, 0, '不得因模型刷新改动 Key 权限');
  } finally { await f.cleanup(); }

  // provider 未注册：跳过，不产生刷新失败噪声
  const missing = fixture({ providers: [row('wanneng-lingxi', ['glm-5.2'])], keys: [key([], {})] });
  try {
    await missing.sync.runNow({ refresh: true });
    const ids = missing.calls.filter((c) => c.action === 'refresh').map((c) => c.id);
    assert(!ids.includes('wanneng-codearts'), '未注册的 provider 不应触发刷新');
    assert(!missing.readState().conflicts.some((c) => c.code === 'model-refresh'), '未注册不能被当成刷新失败');
  } finally { await missing.cleanup(); }
}

async function testSuppressionAcrossRuns() {
  const f = fixture({ providers: [row('local', ['one', 'two'])], keys: [key(['local/*'], {})] });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('local', true);
    await f.sync.flush();
    const target = f.keys[0];
    target.models = target.models.filter((ref) => ref !== 'local/one');
    delete target.aliases.one;
    fs.writeFileSync(f.callerFile, JSON.stringify(f.keys, null, 2));
    await f.sync.runNow();
    assert(!f.readKey().models.includes('local/one'));
    assert(!f.readKey().aliases.one);
    await f.sync.runNow();
    assert(!f.readKey().models.includes('local/one'), '第二轮不得复活外部删除的 Model');
    assert(!f.readKey().aliases.one, '第二轮不得复活外部删除的 alias');
    assert(f.readState().conflicts.some((c) => c.code === 'suppressed-model' || c.code === 'suppressed-alias'));
    await f.sync.setProvider('local', true);
    await f.sync.flush();
    assert(f.readKey().models.includes('local/one'), '明确重新授权后才允许恢复');
    assert.strictEqual(f.readKey().aliases.one, 'local/one');
  } finally { await f.cleanup(); }
}

async function testCallerKeyDrift() {
  let f = fixture({
    providers: [row('local', ['one']), row('other', ['manual'])], keys: [key(['local/*', 'other/manual'], {})],
    onRefresh: (id, current) => {
      if (id === 'local') {
        f.keys[0].aliases.manual = 'other/manual';
        fs.writeFileSync(f.callerFile, JSON.stringify(f.keys, null, 2));
      }
      return current;
    },
  });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('local', true);
    await f.sync.flush();
    assert.strictEqual(f.readKey().aliases.manual, 'other/manual', '刷新期间新增的手工 alias 必须进入新规划并保留');
  } finally { await f.cleanup(); }

  f = fixture({
    providers: [row('local', ['one'])], keys: [key(['local/*'], {})],
    onWrite: async (action, target) => {
      if (action === 'models-key') {
        target.aliases.manual = 'other/manual';
        fs.writeFileSync(f.callerFile, JSON.stringify(f.keys, null, 2));
      }
    },
  });
  try {
    await f.sync.selectKey(KEY_ID);
    await f.sync.setProvider('local', true);
    await assert.rejects(f.sync.flush(), /外部修改/);
    assert.strictEqual(f.readKey().aliases.manual, 'other/manual', '写前漂移必须停止 aliases 全量覆盖');
    assert(!f.calls.some((c) => c.action === 'aliases-key'), '发现漂移后不得继续写 aliases');
  } finally { await f.cleanup(); }
}

async function main() {
  const tests = [
    ['状态与 Key 边界', testStateAndEligibility],
    ['裸名、同名组与外部修改规划', testPlanner],
    ['旧27→真实11、首次接管、幂等、撤销恢复', testStaleRefreshAdoptionAndRevoke],
    ['刷新失败保留缓存', testFailedRefreshKeepsCache],
    ['写入途中撤销的代次收敛', testRevisionDuringWrite],
    ['手工权限保护与崩溃日志收敛', testManualPermissionsAndCrashRecovery],
    ['并发授权与撤销串行化', testConcurrentMutations],
    ['未授权 aliases 也刷新自建模型', testOwnedModelRefreshWithoutAliases],
    ['外部删除跨轮 suppression', testSuppressionAcrossRuns],
    ['caller-key 外部漂移保护', testCallerKeyDrift],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
