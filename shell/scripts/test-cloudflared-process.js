'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  CloudflaredProcess, buildArgs, buildEnv, redactText,
} = require('../src/tunnel/cloudflared-process');

function fakeChild(pid = 1234) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-cloudflared-process-'));
  try {
    const quickChild = fakeChild();
    let quickOptions;
    const quick = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'quick', guardPort: 17901, dataDir: path.join(root, 'quick'),
      spawnFn: (_bin, _args, options) => { quickOptions = options; return quickChild; },
      killTree: async () => { quickChild.emit('exit', 0, null); },
      env: { TUNNEL_TOKEN: 'inherited', HTTPS_PROXY: 'http://inherited', PATH: '/bin' },
      startupTimeoutMs: 500,
    });
    const quickStart = quick.start();
    quickChild.stderr.emit('data', 'INF https://abc-def-123');
    quickChild.stderr.emit('data', '.trycloudflare.com\nRegistered tunnel connection\n');
    await quickStart;
    assert.strictEqual(quick.publicUrl, 'https://abc-def-123.trycloudflare.com');
    assert.ok(!quickOptions.env.TUNNEL_TOKEN, 'Quick 不得继承 Token');
    assert.ok(!quickOptions.env.HTTPS_PROXY, '旧代理应被清理');
    assert.strictEqual(quickOptions.env.HOME, path.join(root, 'quick'));
    assert.ok(quickOptions.args === undefined, '参数不应塞进 options');
    await quick.stop();
    assert.strictEqual(quick.exited, true);

    const namedChild = fakeChild(2345);
    let namedArgs;
    let namedEnv;
    const named = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'named', guardPort: 17902,
      publicUrl: 'https://api.example.com', token: 'secret-token', dataDir: path.join(root, 'named'),
      runtimeProxy: 'http://proxy.local:8080',
      spawnFn: (_bin, args, options) => { namedArgs = args; namedEnv = options.env; return namedChild; },
      killTree: async () => { namedChild.emit('exit', 0, null); },
      startupTimeoutMs: 500,
    });
    const logs = [];
    named.on('log', (line) => logs.push(line));
    const namedStart = named.start();
    namedChild.stdout.emit('data', 'failed secret-token\nRegistered tunnel connection\n');
    await namedStart;
    assert.strictEqual(named.publicUrl, 'https://api.example.com');
    assert.ok(!namedArgs.includes('secret-token'), 'Token 不得出现在 argv');
    assert.ok(!namedArgs.includes('--token'));
    assert.strictEqual(namedEnv.TUNNEL_TOKEN, 'secret-token');
    assert.strictEqual(namedEnv.HTTPS_PROXY, 'http://proxy.local:8080');
    assert.ok(logs.join('').includes('[已隐藏]'));
    assert.ok(!logs.join('').includes('secret-token'));
    await named.stop();

    const invalidChild = fakeChild(3456);
    let killed = false;
    const invalid = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'named', guardPort: 17903,
      token: 'bad-token', dataDir: path.join(root, 'invalid'),
      spawnFn: () => invalidChild,
      killTree: async () => { killed = true; invalidChild.emit('exit', 1, null); },
      startupTimeoutMs: 500,
    });
    const invalidStart = invalid.start();
    invalidChild.stderr.emit('data', 'failed to parse tunnel token');
    await assert.rejects(invalidStart, (e) => e.code === 'TOKEN_INVALID');
    assert.strictEqual(killed, true);

    const crashChild = fakeChild(4567);
    const crash = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'quick', guardPort: 17904, dataDir: path.join(root, 'crash'),
      spawnFn: () => crashChild,
      killTree: async () => { crashChild.emit('exit', 0, null); },
      startupTimeoutMs: 500,
    });
    const crashStart = crash.start();
    crashChild.stderr.emit('data', 'https://crash.trycloudflare.com\nRegistered tunnel connection\n');
    await crashStart;
    const exitInfo = new Promise((resolve) => crash.once('exit', resolve));
    crashChild.emit('exit', 1, null);
    assert.deepStrictEqual(await exitInfo, { code: 1, signal: null, expected: false });
    await crash.stop();

    const stuckChild = fakeChild(5678);
    const stuck = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'quick', guardPort: 17905, dataDir: path.join(root, 'stuck'),
      spawnFn: () => stuckChild,
      killTree: async () => {},
      startupTimeoutMs: 500,
      stopTimeoutMs: 20,
    });
    const stuckStart = stuck.start();
    stuckChild.stderr.emit('data', 'https://stuck.trycloudflare.com\nRegistered tunnel connection\n');
    await stuckStart;
    await assert.rejects(() => stuck.stop(), (e) => e.code === 'STOP_UNCONFIRMED');
    assert.strictEqual(stuckChild.listenerCount('exit'), 1, '停止超时不得累积等待监听器');
    stuckChild.emit('exit', 0, null);
    await stuck.stop();

    const duplicateChild = fakeChild(6789);
    let duplicateKills = 0;
    const duplicate = new CloudflaredProcess({
      binary: '/fake/cloudflared', mode: 'quick', guardPort: 17906, dataDir: path.join(root, 'duplicate'),
      spawnFn: () => duplicateChild,
      killTree: async () => {
        duplicateKills++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        duplicateChild.emit('exit', 0, null);
      },
      startupTimeoutMs: 500,
      stopTimeoutMs: 100,
    });
    const duplicateStart = duplicate.start();
    duplicateChild.stderr.emit('data', 'https://duplicate.trycloudflare.com\nRegistered tunnel connection\n');
    await duplicateStart;
    await Promise.all([duplicate.stop(), duplicate.stop()]);
    assert.strictEqual(duplicateKills, 1, '并发 stop 必须共享一次 kill');
    assert.strictEqual(duplicateChild.listenerCount('exit'), 0, '退出后不得残留停止等待监听器');

    const env = buildEnv({ CLOUDFLARED_PROXY: 'old', ALL_PROXY: 'old' }, '/isolated', 'quick', 'unused');
    assert.strictEqual(env.CLOUDFLARED_PROXY, undefined);
    assert.strictEqual(env.ALL_PROXY, undefined);
    assert.strictEqual(env.NO_PROXY, '127.0.0.1,localhost');
    assert.ok(buildArgs({ mode: 'quick', guardPort: 1234, configPath: '/x' }).includes('--url'));
    assert.strictEqual(redactText('Authorization: Bearer abc', []), 'Authorization: Bearer [已隐藏]');

    console.log('PASS cloudflared 进程：Quick/Named、环境隔离、Token 脱敏、退出与停止确认');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
