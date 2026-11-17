'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { TunnelStore } = require('../src/tunnel/tunnel-store');
const { TunnelManager } = require('../src/tunnel/tunnel-manager');
const { RemoteAuth } = require('../src/tunnel/remote-auth');

const NAMED_TOKEN = Buffer.from(JSON.stringify({ a: 'account', t: 'lx-tunnel', s: 'secret' })).toString('base64url');
const OTHER_TOKEN = Buffer.from(JSON.stringify({ a: 'account', t: 'other-tunnel', s: 'secret' })).toString('base64url');

class FakeProcess extends EventEmitter {
  constructor(options, number, failStop = false, startPromise = null) {
    super();
    this.options = options;
    this.pid = 1000 + number;
    this.publicUrl = options.mode === 'quick' ? `https://quick-${number}.trycloudflare.com` : options.publicUrl;
    this.exited = false;
    this.stopCalls = 0;
    this.failStop = failStop;
    this.startPromise = startPromise;
  }
  async start() {
    if (this.startPromise) await this.startPromise;
    return this;
  }
  async stop() {
    this.stopCalls++;
    if (this.failStop) {
      const error = new Error('injected stop failure');
      error.code = 'STOP_UNCONFIRMED';
      throw error;
    }
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', { code: 0, signal: null, expected: true });
  }
  crash() {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', { code: 1, signal: null, expected: false });
  }
}

class FakeGateway {
  constructor(options) { this.options = options; this.closeCalls = 0; }
  async listen() { return { port: this.options.port }; }
  async close() { this.closeCalls++; }
  setPublicUrl(value) { this.publicUrl = value; }
}

async function waitFor(check, message, timeout = 1000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时: ${message}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-tunnel-manager-'));
  const processes = [];
  const gateways = [];
  const failingUrls = new Set();
  const healthOutcomes = [];
  let healthCalls = 0;
  const unavailable = new Set();
  let processNumber = 0;
  let binaryEnsures = 0;
  let failNextStop = false;
  let nextStartPromise = null;
  let networkReady = true;
  const store = new TunnelStore(root);
  const remoteAuth = new RemoteAuth({ store });
  const adapters = {
    async preflight(id) {
      if (unavailable.has(id)) {
        unavailable.delete(id);
        const error = new Error('temporary unavailable');
        error.code = 'TARGET_UNAVAILABLE';
        throw error;
      }
      return { ok: true, localHealth: 'ok' };
    },
  };
  const manager = new TunnelManager({
    store, adapters, remoteAuth, staticDir: root,
    binary: { async ensure() { binaryEnsures++; return '/fake/cloudflared'; }, status() { return { installed: true }; } },
    processFactory(options) {
      const process = new FakeProcess(options, ++processNumber, failNextStop, nextStartPromise);
      failNextStop = false;
      nextStartPromise = null;
      processes.push(process);
      return process;
    },
    apiGatewayFactory(options) { const gateway = new FakeGateway(options); gateways.push(gateway); return gateway; },
    remoteGatewayFactory(options) { const gateway = new FakeGateway(options); gateways.push(gateway); return gateway; },
    healthCheck: async (url) => {
      healthCalls++;
      if (healthOutcomes.length) return { ok: healthOutcomes.shift(), status: 503 };
      return { ok: ![...failingUrls].some((bad) => url.startsWith(bad)) };
    },
    localCheck: async () => ({ ok: true }),
    portCheck: async () => ({ free: true }),
    proxy: { config: () => ({ enabled: false, scopes: {} }), validProxyUrl: () => false },
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    publicRetryDelaysMs: [1, 2, 3],
    healthIntervalMs: 10,
    networkProbe: async () => networkReady,
    networkWaitMs: 20,
  });

  try {
    assert.strictEqual(manager.snapshot().targets.length, 6);
    healthOutcomes.push(false, false, true);
    manager.start('workbuddy');
    await waitFor(() => manager.statusOf('workbuddy').phase === 'running', 'WorkBuddy 上线');
    assert.strictEqual(healthCalls, 3, '公网启动检查必须按退避重试后再判失败');
    assert.strictEqual(processes.length, 1);
    assert.strictEqual(manager.statusOf('workbuddy').publicUrl, 'https://quick-1.trycloudflare.com');
    manager.start('workbuddy');
    assert.strictEqual(processes.length, 1, '重复启动不得创建第二个进程');
    const freePortCheck = manager.portCheck;
    manager.portCheck = async () => { throw new Error('injected self-port conflict'); };
    const runningPreflight = await manager.preflight('workbuddy');
    assert.strictEqual(runningPreflight.ok, true, '运行中预检不得把自身入口判为端口冲突');
    manager.portCheck = freePortCheck;
    await assert.rejects(() => manager.verifyToken('workbuddy', NAMED_TOKEN), (e) => e.code === 'TUNNEL_ACTIVE');

    // 系统唤醒恢复：不重启隧道进程，只清失败计数并延迟重新探测
    const resumeRuntime = manager.runtimes.get('workbuddy');
    resumeRuntime.healthFailures = 2;
    const beforeResume = processes.length;
    const resumeResult = manager.handleResume({ delayMs: 20 });
    assert.ok(resumeResult.scheduled >= 1, '唤醒恢复应排程');
    assert.strictEqual(resumeRuntime.healthFailures, 0, '唤醒应立即重置公网失败计数');
    assert.strictEqual(processes.length, beforeResume, '唤醒不得重启隧道进程');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(processes.length, beforeResume, '唤醒探测后仍不得重启进程');
    assert.strictEqual(manager.statusOf('workbuddy').phase, 'running');

    const first = processes[0];
    first.crash();
    await waitFor(() => processes.length === 2 && manager.statusOf('workbuddy').phase === 'running', '崩溃后重连');
    first.emit('exit', { code: 1, signal: null, expected: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(processes.length, 2, '旧进程事件不得影响新实例');
    await manager.stop('workbuddy');
    assert.strictEqual(manager.statusOf('workbuddy').phase, 'stopped');
    assert.strictEqual(processes[1].stopCalls, 1);
    assert.ok(gateways.every((gateway) => gateway.closeCalls >= 1));

    // 首次启动失败（START_TIMEOUT）也必须持续重连，不能停在 error 等用户手动点
    console.log('\n[启动失败自动重连]');
    const startError = new Error('cloudflared 建立连接超时');
    startError.code = 'START_TIMEOUT';
    nextStartPromise = new Promise((_, reject) => setTimeout(() => reject(startError), 0));
    const beforeFailedStart = processes.length;
    manager.start('loomy');
    await waitFor(() => processes.length >= beforeFailedStart + 2, '首次启动失败后应自动重连');
    await waitFor(() => manager.statusOf('loomy').phase === 'running', '重连后应上线', 5000);
    assert.strictEqual(manager.statusOf('loomy').phase, 'running', '非致命启动错误必须继续重连直到成功');
    await manager.stop('loomy');

    // 断网期间不反复拉起 cloudflared，只等待；网络恢复后立即重连
    console.log('\n[断网等待与恢复]');
    const offlineError = new Error('cloudflared 建立连接超时');
    offlineError.code = 'START_TIMEOUT';
    nextStartPromise = new Promise((_, reject) => setTimeout(() => reject(offlineError), 0));
    networkReady = false;
    const beforeOffline = processes.length;
    manager.start('lingxi');
    await waitFor(() => manager.statusOf('lingxi').phase === 'reconnecting', '应进入重连等待');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(processes.length, beforeOffline + 1, '断网期间不得反复拉起 cloudflared');
    networkReady = true;
    await waitFor(() => manager.statusOf('lingxi').phase === 'running', '网络恢复后应自动上线', 5000);
    assert.strictEqual(manager.statusOf('lingxi').phase, 'running', '网络恢复后必须上线');
    await manager.stop('lingxi');

    unavailable.add('codearts');
    store.updateTarget('codearts', { autoStart: true });
    manager.startAutoStart();
    await waitFor(() => manager.statusOf('codearts').phase === 'running', 'autoStart 等待目标恢复');
    assert.strictEqual(manager.statusOf('codearts').retryAttempt >= 0, true);
    await manager.stop('codearts');

    manager.start('loomy');
    await waitFor(() => manager.statusOf('loomy').phase === 'running', 'Loomy 上线');
    const loomyCount = processes.length;
    const oldUrl = manager.statusOf('loomy').publicUrl;
    failingUrls.add(oldUrl);
    await waitFor(() => processes.length > loomyCount && manager.statusOf('loomy').phase === 'running', '公网连续失败后重连');
    assert.notStrictEqual(manager.statusOf('loomy').publicUrl, oldUrl);
    await manager.stop('loomy');

    manager.start('manager');
    await waitFor(() => manager.statusOf('manager').phase === 'error', '未设密码阻断');
    assert.strictEqual(manager.statusOf('manager').lastError.code, 'PASSWORD_REQUIRED');
    const beforeManager = processes.length;
    assert.strictEqual(processes.length, beforeManager);
    await remoteAuth.setPassword(null, 'manager-password');
    manager.start('manager');
    await waitFor(() => manager.statusOf('manager').phase === 'running', 'Manager 上线');
    assert.strictEqual(gateways.at(-1).publicUrl, manager.statusOf('manager').publicUrl);
    await manager.stop('manager');

    store.updateTarget('lingxi', { mode: 'named', publicUrl: 'https://lx.example.com' });
    manager.start('lingxi');
    await waitFor(() => manager.statusOf('lingxi').phase === 'error', 'Named 缺 Token 阻断');
    assert.strictEqual(manager.statusOf('lingxi').lastError.code, 'TOKEN_REQUIRED');
    await assert.rejects(() => manager.verifyToken('lingxi', 'bad-token'), (e) => e.code === 'INVALID_TOKEN');
    const gatewayBeforeVerify = gateways.length;
    const healthBeforeVerify = healthCalls;
    const verified = await manager.verifyToken('lingxi', NAMED_TOKEN);
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.tunnelId, 'lx-tunnel');
    assert.strictEqual(gateways.length, gatewayBeforeVerify, '验证不得启动 guard gateway');
    assert.strictEqual(healthCalls, healthBeforeVerify, '验证不得调用公网健康检查');
    assert.strictEqual(processes.at(-1).stopCalls, 1, '验证成功后必须先停止临时进程');
    manager.start('lingxi');
    await waitFor(() => manager.statusOf('lingxi').phase === 'running', 'Named 上线');
    assert.strictEqual(manager.statusOf('lingxi').publicUrl, 'https://lx.example.com');
    assert.strictEqual(processes.at(-1).options.token, NAMED_TOKEN);
    assert.strictEqual(processes.at(-1).options.publicUrl, 'https://lx.example.com');
    await manager.stop('lingxi');
    await assert.rejects(() => manager.verifyToken('codearts', NAMED_TOKEN), (e) => e.code === 'DUPLICATE_TOKEN');

    failNextStop = true;
    await assert.rejects(() => manager.verifyToken('codearts', OTHER_TOKEN), (e) => e.code === 'STOP_UNCONFIRMED');
    assert.strictEqual(store.get('codearts').verifiedAt, 0, '停止失败不得保存验证');
    assert.ok(manager.runtimes.get('codearts').verificationProcess, '停止失败必须保留验证进程引用');
    manager.runtimes.get('codearts').verificationProcess.failStop = false;
    await manager.stopAll();

    let resolveStart;
    nextStartPromise = new Promise((resolve) => { resolveStart = resolve; });
    const pendingVerification = manager.verifyToken('codearts', OTHER_TOKEN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => manager.start('codearts'), (e) => e.code === 'TOKEN_VERIFY_ACTIVE');
    store.updateTarget('codearts', { publicUrl: 'https://changed.example.com' });
    resolveStart();
    await assert.rejects(pendingVerification, (e) => e.code === 'TOKEN_CHANGED');
    assert.strictEqual(store.get('codearts').verifiedAt, 0, '配置变化后旧验证不得保存');

    manager.start('workbuddy');
    await waitFor(() => manager.statusOf('workbuddy').phase === 'running', '停止失败用例启动');
    const stuck = processes.at(-1);
    stuck.failStop = true;
    await assert.rejects(() => manager.stop('workbuddy'), (e) => e.code === 'STOP_UNCONFIRMED');
    assert.strictEqual(manager.statusOf('workbuddy').phase, 'error');
    assert.strictEqual(manager.statusOf('workbuddy').desiredRunning, false);
    assert.throws(() => manager.start('workbuddy'), (e) => e.code === 'STOP_UNCONFIRMED');
    stuck.failStop = false;
    await manager.stop('workbuddy');

    manager.start('loomy');
    await waitFor(() => manager.statusOf('loomy').phase === 'running', '重连清理失败用例启动');
    const reconnectStuck = processes.at(-1);
    const reconnectCount = processes.length;
    reconnectStuck.failStop = true;
    failingUrls.add(manager.statusOf('loomy').publicUrl);
    await waitFor(() => manager.statusOf('loomy').phase === 'error', '重连清理失败后进入错误');
    assert.strictEqual(manager.statusOf('loomy').lastError.code, 'STOP_UNCONFIRMED');
    assert.strictEqual(processes.length, reconnectCount, '旧进程未确认停止时不得创建新实例');
    reconnectStuck.failStop = false;
    await manager.stop('loomy');

    manager.start('workbuddy');
    await waitFor(() => manager.statusOf('workbuddy').phase === 'running', '健康竞态用例启动');
    manager.localCheck = async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return { ok: true }; }
    const generation = manager.runtimes.get('workbuddy').generation;
    const oldHealth = manager._healthTick('workbuddy', generation);
    await manager.stop('workbuddy');
    await oldHealth;
    assert.strictEqual(manager.statusOf('workbuddy').phase, 'stopped', '旧健康请求不得覆盖停止状态');
    assert.strictEqual(manager.statusOf('workbuddy').publicHealth, 'unknown');

    manager.start('workbuddy');
    await waitFor(() => manager.statusOf('workbuddy').phase === 'running', 'stopAll 前启动');
    assert.strictEqual(manager.hasActiveProcesses(), true);
    await manager.stopAll();
    assert.strictEqual(manager.hasActiveProcesses(), false);
    assert.ok(manager.snapshot().targets.every((target) => target.phase === 'stopped'));
    assert.strictEqual(binaryEnsures > 0, true);
    assert.ok(!JSON.stringify(manager.snapshot()).includes(NAMED_TOKEN), '快照不得包含 Token');
    assert.ok(!manager.logs('lingxi').lines.join('').includes(NAMED_TOKEN), '日志不得包含 Token');

    console.log('PASS TunnelManager：六目标、崩溃重连、autoStart、公网健康、Named、stopAll 与脱敏');
  } finally {
    if (manager.hasActiveProcesses()) await manager.stopAll().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
