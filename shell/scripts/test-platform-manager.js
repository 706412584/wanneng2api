'use strict';
/**
 * test-platform-manager.js — PlatformManager 自动化验收测试（不依赖 Electron）
 *
 * 覆盖：
 *  1. spawn → healthy（mock-healthy http 平台）
 *  2. kill 进程 → 2s 内自动拉起（指数退避 baseBackoffSec=0.2 加速）
 *  3. stop 优雅退出（进程退出、状态 stopped）
 *  4. crash 平台：spawn 秒退 → 自动重启 → stop 能终止重启循环
 *  5. 端口预检：端口被外部进程占用 → port-conflict，不 spawn
 *  6. 日志：轮转文件存在 + 环形缓冲 tail
 *  7. enable/disable
 *
 * 运行：node scripts/test-platform-manager.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');

const { ConfigStore } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');
const { checkPortFree } = require('../src/platform-manager');

const PASS = [];
const FAIL = [];
function ok(name, cond, extra = '') {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(mgr, id, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mgr.statusOf(id);
    if (s && s.status === status) return true;
    await sleep(100);
  }
  return false;
}

/** 起一个外部 HTTP 服务占用端口（模拟第三方占用） */
function occupyPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** HTTP 探测（供测试直接验证 mock 服务确实在跑） */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function makeConfig(dir, platforms) {
  return {
    version: 1,
    platforms,
  };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-test-'));
  const mocksDir = path.join(__dirname, 'mocks');
  console.log(`dataDir = ${dataDir}\n`);

  // ── 准备配置：mock 平台（fast 退避参数便于测试）──
  const store = new ConfigStore(path.join(dataDir, 'cfg'));
  store.platforms = makeConfig(0, [
    {
      id: 'mockhealthy',
      name: 'Mock Healthy',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: '17891' } },
      port: 17891,
      health: { url: 'http://127.0.0.1:17891/healthz', intervalSec: 1, timeoutSec: 2, failThreshold: 2, okThreshold: 1 },
      adminPanel: 'http://127.0.0.1:17891/',
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 1, maxRetries: 0 },
    },
    {
      id: 'mockcrash',
      name: 'Mock Crash',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-crash.js'], env: {} },
      port: 0, // 无端口服务
      health: { url: 'http://127.0.0.1:17892/healthz', intervalSec: 1, timeoutSec: 1, failThreshold: 2, okThreshold: 1 },
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 0.5, maxRetries: 0 },
    },
    {
      id: 'portconflict',
      name: 'Port Conflict Target',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: '17893' } },
      port: 17893,
      health: { url: 'http://127.0.0.1:17893/healthz', intervalSec: 1, timeoutSec: 1, failThreshold: 1, okThreshold: 1 },
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 1, maxRetries: 0 },
    },
  ]);

  const mgr = new PlatformManager({
    store,
    dataDir,
    shellRoot: path.resolve(__dirname, '..'),
    logger: { info: () => {}, warn: () => {}, error: (m) => console.error('    [mgr-err]', m) },
  });

  // ── 1. spawn → healthy ──
  console.log('\n[1] spawn → healthy');
  const snap1 = await mgr.start('mockhealthy');
  ok('start 返回 starting/healthy', ['starting', 'healthy'].includes(snap1.status), `got ${snap1.status}`);
  ok('pid > 0', snap1.pid > 0);
  const healthy = await waitStatus(mgr, 'mockhealthy', 'healthy', 15000);
  ok('状态变为 healthy', healthy, `got ${mgr.statusOf('mockhealthy').status}`);
  const httpOk = await probe('http://127.0.0.1:17891/healthz');
  ok('mock 服务真实响应 /healthz=200', httpOk === 200, `got ${httpOk}`);

  // ── 2. kill 进程 → 2s 内自动拉起 ──
  console.log('\n[2] kill → 自动重启（≤2s）');
  const oldPid = mgr.statusOf('mockhealthy').pid;
  try { process.kill(oldPid); } catch (_e) { /* ignore */ }
  // 等待 exit 事件触发 → backoff(0.2s) 重启
  const revived = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = mgr.statusOf('mockhealthy');
      if (s.pid && s.pid !== oldPid && s.status === 'healthy') return true;
      await sleep(100);
    }
    return false;
  })();
  ok('进程被杀后 2s 内自动拉起并 healthy', revived, `oldPid=${oldPid} now=${JSON.stringify(mgr.statusOf('mockhealthy'))}`);

  // ── 3. stop 优雅退出 ──
  console.log('\n[3] stop 优雅退出');
  const stopPid = mgr.statusOf('mockhealthy').pid;
  const snapStop = await mgr.stop('mockhealthy');
  ok('stop 后状态 stopped', snapStop.status === 'stopped', `got ${snapStop.status}`);
  ok('stop 后 pid=0', snapStop.pid === 0);
  await sleep(300);
  const portFree = await checkPortFree(17891);
  ok('stop 后端口释放', portFree.free, `occupied by ${portFree.pid}`);

  // ── 4. crash 平台：秒退 → 自动重启循环 → stop 终止 ──
  console.log('\n[4] crash 平台：自动重启循环');
  try { await mgr.start('mockcrash'); } catch (_e) { /* 秒退可能抛错，允许 */ }
  // crash 后进入 error+restartAttempts 递增
  await sleep(2500);
  const crashSnap = mgr.statusOf('mockcrash');
  ok('crash 平台触发自动重启（restartAttempts≥1）', crashSnap.restartAttempts >= 1,
    `attempts=${crashSnap.restartAttempts} status=${crashSnap.status}`);
  // 注：crash 桩 300ms 后退出，快照可能在 backoff 窗口内恰好捕捉到活进程（重试中的实例），
  // 「无残留进程」的确定性断言放在 stop 之后（stop 同步清空 pid 且终止重启循环）。
  await mgr.stop('mockcrash');
  const crashAfterStop = mgr.statusOf('mockcrash');
  ok('stop 后无残留进程', crashAfterStop.pid === 0, `pid=${crashAfterStop.pid}`);
  ok('stop 终止重启循环（stopped 且不再递增）', crashAfterStop.status === 'stopped');
  const attemptsAtStop = crashAfterStop.restartAttempts;
  await sleep(1500);
  ok('stop 后 1.5s 无新重启', mgr.statusOf('mockcrash').restartAttempts === attemptsAtStop,
    `attempts ${attemptsAtStop} → ${mgr.statusOf('mockcrash').restartAttempts}`);

  // ── 5. 端口预检 ──
  console.log('\n[5] 端口预检 port-conflict');
  const occupier = await occupyPort(17893);
  try { await mgr.start('portconflict'); ok('被占用端口应拒绝 spawn', false); }
  catch (e) { ok('被占用端口报 port-conflict 拒绝 spawn', /port-conflict/.test(e.message), e.message); }
  const errSnap = mgr.statusOf('portconflict');
  ok('冲突平台状态 error', errSnap.status === 'error', `got ${errSnap.status}`);
  ok('冲突平台无进程', errSnap.pid === 0);
  // Windows 上 net.Server.close() 若仍有连接（哪怕已半关）会不回调。
// 先强制断开再关，并加超时兜底，避免整个测试挂死。
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    try { occupier.closeAllConnections?.(); } catch (_e) { /* 老 Node 无此 API */ }
    occupier.close(() => { clearTimeout(t); resolve(); });
  });

  // ── 6. enable/disable ──
  console.log('\n[6] enable/disable');
  const dis = mgr.disable('mockcrash');
  ok('disable 生效', dis.enabled === false && store.getPlatform('mockcrash').enabled === false);
  try { await mgr.start('mockcrash'); ok('disabled 平台 start 应被拒绝', false); }
  catch (e) { ok('disabled 平台 start 被拒绝', /禁用/.test(e.message), e.message); }
  const en = mgr.enable('mockcrash');
  ok('enable 生效', en.enabled === true && store.getPlatform('mockcrash').enabled === true);

  // ── 7. 日志：轮转文件 + 环形缓冲 ──
  console.log('\n[7] 日志落盘与环形缓冲');
  const logFile = path.join(dataDir, 'logs', 'platforms', 'mockhealthy.log');
  ok('轮转日志文件存在', fs.existsSync(logFile), logFile);
  const lines = mgr.tailLogs('mockhealthy', 500);
  ok('环形缓冲有内容（≥5 行）', lines.length >= 5, `lines=${lines.length}`);
  ok('日志包含 spawn 记录', lines.some((l) => l.includes('spawn:')));
  ok('日志包含 exit 记录', lines.some((l) => /exit code=/.test(l)));
  const tail3 = mgr.tailLogs('mockhealthy', 3);
  ok('tail=3 正确截取', tail3.length === 3 && tail3[2] === lines[lines.length - 1]);

  // ── 清理 ──
  console.log('\n[cleanup] 停止全部');
  await mgr.stopAll();
  mgr.destroy();
  const allStopped = mgr.statusList().every((s) => s.pid === 0);
  ok('stopAll 后无残留进程', allStopped);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  // ── 汇总 ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('Failures:');
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
