'use strict';
/**
 * test-orchestration.js — sub2api 依赖编排测试（§8，不依赖 Electron）
 *
 * 不使用真实 PG/Redis：用 Node 桩程序伪装 pg_ctl/initdb/pg_isready/redis-server，
 * 验证 PlatformManager 的编排顺序、环境注入与反序停止逻辑。
 *
 * 桩行为：
 *   initdb.exe    → 创建 pgdata 标记文件
 *   pg_ctl.exe    → start: spawn 持久桩进程（充当“postgres”），写 pid 文件；
 *                   stop: 读取 pid 文件 taskkill
 *   pg_isready.exe→ postgres pid 文件存在时输出 "accepting connections" 退出 0
 *   redis-server.exe → 起一个 TCP 服务器，收到 "PING\r\n" 回 "+PONG\r\n"
 *
 * sub2api 主程序用 node 桩：校验注入的 DATABASE_URL/REDIS_HOST/REDIS_PORT 后
 * 把内容写到 envdump 文件并保持运行，/health 返回 200。
 *
 * 运行：node scripts/test-orchestration.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');

const { ConfigStore } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');

const PASS = [];
const FAIL = [];
function ok(name, cond, extra = '') {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push(`${name}${extra ? ' — ' + extra : ''}`); console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写一个 .cmd 桩（Windows 可直接 spawn） */
function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

async function waitStatus(mgr, id, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mgr.statusOf(id);
    if (s && s.status === status) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-orch-'));
  const mocksDir = path.resolve(__dirname, 'mocks');
  console.log(`dataDir = ${dataDir}`);

  // ── 伪造 deps 目录 ──
  const pgBin = path.join(dataDir, 'deps', 'pg15', 'bin');
  const redisBin = path.join(dataDir, 'deps', 'redis');
  fs.mkdirSync(pgBin, { recursive: true });
  fs.mkdirSync(redisBin, { recursive: true });
  const nodeExe = process.execPath;

  // initdb.exe：cmd 桩 → 调 node initdb-stub.js
  fs.writeFileSync(path.join(pgBin, 'initdb.cmd'),
    `@echo off\r\n"${nodeExe}" "${path.join(mocksDir, 'pg-initdb-stub.js')}" %*\r\n`);
  fs.writeFileSync(path.join(pgBin, 'pg_ctl.cmd'),
    `@echo off\r\n"${nodeExe}" "${path.join(mocksDir, 'pg-ctl-stub.js')}" %*\r\n`);
  fs.writeFileSync(path.join(pgBin, 'pg_isready.cmd'),
    `@echo off\r\n"${nodeExe}" "${path.join(mocksDir, 'pg-isready-stub.js')}" %*\r\n`);
  fs.writeFileSync(path.join(redisBin, 'redis-server.cmd'),
    `@echo off\r\n"${nodeExe}" "${path.join(mocksDir, 'redis-stub.js')}" %*\r\n`);
  // psql/createdb 桩（_ensureDb 用 psql 查库）
  fs.writeFileSync(path.join(pgBin, 'psql.cmd'),
    `@echo off\r\n"${nodeExe}" -e "process.stdout.write('1')" %*\r\n`);
  fs.writeFileSync(path.join(pgBin, 'createdb.cmd'),
    `@echo off\r\n@rem createdb stub\r\nexit /b 0\r\n`);

  // ── 配置：sub2api 主程序用 node 桩 ──
  const store = new ConfigStore(dataDir);
  store.platforms = {
    version: 1,
    platforms: [
      {
        id: 'sub2api',
        name: 'Sub2API Stub',
        type: 'go-binary',
        enabled: true,
        mode: 'managed',
        workDir: mocksDir,
        requires: ['pg', 'redis'],
        run: { binary: 'node', args: ['sub2api-stub.js'], env: {} },
        port: 17897,
        health: { url: 'http://127.0.0.1:17897/health', intervalSec: 1, timeoutSec: 2, failThreshold: 2, okThreshold: 1 },
        restart: { baseBackoffSec: 0.5, maxBackoffSec: 2, maxRetries: 0 },
      },
    ],
  };

  const mgr = new PlatformManager({
    store, dataDir, logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  console.log('\n[1] start sub2api → 编排 pg → redis → server');
  const snap = await mgr.start('sub2api');
  ok('start 返回（starting/healthy）', ['starting', 'healthy'].includes(snap.status), snap.status);
  const healthy = await waitStatus(mgr, 'sub2api', 'healthy', 20000);
  ok('sub2api 最终 healthy', healthy, mgr.statusOf('sub2api').status);

  const rt = mgr.getRuntime('sub2api');
  ok('deps.pg healthy', rt.deps.pg.status === 'healthy', JSON.stringify(rt.deps));
  ok('deps.redis healthy', rt.deps.redis.status === 'healthy', JSON.stringify(rt.deps));

  // envdump 校验：主程序桩收到的环境注入
  const dump = JSON.parse(fs.readFileSync(path.join(mocksDir, 'sub2api-envdump.json'), 'utf8'));
  const m = store.manager.sub2api;
  ok('DATABASE_URL 注入（含随机密码/wanneng/5433/sub2api）',
    /^postgres:\/\/wanneng:[0-9a-f]+@127\.0\.0\.1:5433\/sub2api/.test(dump.DATABASE_URL || ''),
    dump.DATABASE_URL);
  ok('REDIS_HOST=127.0.0.1 注入', dump.REDIS_HOST === '127.0.0.1', dump.REDIS_HOST);
  ok('REDIS_PORT=6380 注入', dump.REDIS_PORT === '6380', dump.REDIS_PORT);
  ok('NO_PROXY=* 注入', dump.NO_PROXY === '*', dump.NO_PROXY);
  ok('密码已写入 manager.json', typeof m.dbPassword === 'string' && m.dbPassword.length >= 12);
  ok('密码持久化到 manager.json 文件',
    JSON.parse(fs.readFileSync(path.join(dataDir, 'manager.json'), 'utf8')).sub2api.dbPassword === m.dbPassword);

  // initdb 产物
  ok('initdb 已执行（pgdata 标记）', fs.existsSync(path.join(dataDir, 'platforms', 'sub2api', 'pgdata', 'PG_VERSION')));
  ok('postgresql.conf 生成（port 5433）',
    /port = 5433/.test(fs.readFileSync(path.join(dataDir, 'platforms', 'sub2api', 'pgdata', 'postgresql.conf'), 'utf8')));

  // pgdata 复用：二次 start 不再 initdb（删除标记后再启动应仍成功且无 re-init）
  console.log('\n[2] stop → 反序关闭');
  // 记录 pg“postgres”进程 pid
  const pgPidFile = path.join(dataDir, 'platforms', 'sub2api', 'pgdata', 'postgres.pid');
  const pgPid = Number(fs.readFileSync(pgPidFile, 'utf8'));
  const redisPid = rt.deps.redis.pid;
  ok('postgres 桩进程在跑', pgPid > 0);
  ok('redis 桩进程在跑', redisPid > 0);

  await mgr.stop('sub2api');
  await sleep(500);
  ok('stop 后 sub2api stopped', mgr.statusOf('sub2api').status === 'stopped');
  ok('stop 后 deps 全 stopped', rt.deps.pg.status === 'stopped' && rt.deps.redis.status === 'stopped');
  let pgAlive = false;
  try { process.kill(pgPid, 0); pgAlive = true; } catch (_e) { pgAlive = false; }
  ok('postgres 桩已被 pg_ctl stop 关闭', !pgAlive);
  let redisAlive = false;
  try { process.kill(redisPid, 0); redisAlive = true; } catch (_e) { redisAlive = false; }
  ok('redis 桩进程已退出', !redisAlive);

  // 二次启动：pgdata 已存在 → 不再 initdb
  console.log('\n[3] 二次启动复用 pgdata（无重复 initdb）');
  const initdbMarker = path.join(dataDir, 'platforms', 'sub2api', 'pgdata', 'PG_VERSION');
  const stat1 = fs.statSync(initdbMarker).mtimeMs;
  await mgr.start('sub2api');
  const healthy2 = await waitStatus(mgr, 'sub2api', 'healthy', 20000);
  ok('二次启动 healthy', healthy2, mgr.statusOf('sub2api').status);
  const stat2 = fs.statSync(initdbMarker).mtimeMs;
  ok('未重复 initdb', stat1 === stat2);

  await mgr.stopAll();
  mgr.destroy();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  // 清理 envdump
  try { fs.rmSync(path.join(mocksDir, 'sub2api-envdump.json'), { force: true }); } catch (_e) { /* ignore */ }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
