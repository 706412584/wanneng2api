'use strict';
/**
 * platform-manager.js — 平台进程托管状态机（纯 Node 模块，无 Electron 依赖）
 *
 * 状态机（DESIGN.md §4.3）：
 *   stopped ──start──► starting ──health ok──► healthy
 *                      │                         │ 连续 fail≥failThreshold → degraded → unhealthy
 *                      ▼                         │
 *                    error ◄────crash────────────┘
 *                      │ 意外退出 → 指数退避(baseBackoff→maxBackoff) 自动重启
 *   更新期间：updating（禁止 start/stop）
 *
 * 端口预检：spawn 前探测端口占用，被非本平台 PID 占用 → error(port-conflict)，不 spawn。
 * sub2api 编排（§8）：requires=["pg","redis"] 时按序拉起影子进程，stop 反序。
 */

const { spawn, execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { RingBuffer, RotatingFileWriter } = require('./logs');

const STATES = ['stopped', 'starting', 'healthy', 'degraded', 'unhealthy', 'updating', 'error'];

// ────────────────────────── 工具 ──────────────────────────

/** netstat -ano 找出监听端口的 PID（Windows；失败返回 null） */
function findListeningPid(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        // TCP  0.0.0.0:7866  0.0.0.0:0  LISTENING  1234
        if (parts.length >= 5 && parts[0] === 'TCP' && /^LISTENING$/i.test(parts[3])) {
          const local = parts[1] || '';
          const m = local.match(/:(\d+)$/);
          if (m && Number(m[1]) === port) return resolve(Number(parts[4]));
        }
      }
      resolve(null);
    });
  });
}

/** TCP 连接探测端口是否有监听者 */
function probePortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      try { sock.destroy(); } catch (_e) { /* ignore */ }
      resolve(open);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** 端口预检：free=true 可用；否则返回占用 PID */
async function checkPortFree(port, ownPid = 0) {
  const pid = await findListeningPid(port);
  if (pid === null) {
    // netstat 没看到监听者，再用 TCP 探测兜底（防 netstat 失败）
    const open = await probePortOpen(port);
    return { free: !open, pid: 0 };
  }
  if (ownPid && pid === ownPid) return { free: true, pid };
  return { free: false, pid };
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/pid', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 8000, stdio: 'ignore' },
      () => resolve());
  });
}

function simpleGlobMatch(pattern, relPath) {
  if (!pattern) return false;
  // ** 跨目录，* 单段，? 单字符
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${rx}$`, 'i').test(relPath.replace(/\\/g, '/'));
}

function randomHex(n = 12) {
  return crypto.randomBytes(n).toString('hex');
}

// ────────────────────────── 平台运行时 ──────────────────────────

class PlatformRuntime {
  constructor(id, cfg, mgr) {
    this.id = id;
    this.mgr = mgr;
    this.status = 'stopped';
    this.proc = null;
    this.pid = 0;
    this.startedAt = 0;
    this.lastExitCode = null;
    this.lastError = '';
    this.restartAttempts = 0;
    this.failCount = 0;
    this.okCount = 0;
    this.healthTimer = null;
    this.restartTimer = null;
    this.stopping = false;
    this.version = null;
    this.lastHealthAt = 0;
    this.deps = { pg: { status: 'stopped', pid: 0 }, redis: { status: 'stopped', pid: 0 } };
    this.ring = new RingBuffer(500);
    this.writer = null;
  }

  get cfg() {
    return this.mgr.store.getPlatform(this.id) || {};
  }

  get logFile() {
    return path.join(this.mgr.logsPlatformsDir, `${this.id}.log`);
  }

  _ensureWriter() {
    if (!this.writer) {
      this.writer = new RotatingFileWriter(this.logFile, { rotateBytes: 10 * 1024 * 1024, keepFiles: 5 });
    }
    return this.writer;
  }

  appendLog(stream, text) {
    const ts = new Date().toISOString();
    const line = `${ts} [${stream}] ${String(text).replace(/\r?\n$/, '')}`;
    try { this._ensureWriter().write(line); } catch (_e) { /* 丢弃 */ }
    this.ring.push(line);
    this.mgr.emit('log', this.id, stream, line);
  }

  setStatus(next, extraErr = '') {
    if (next === this.status && !extraErr) return;
    this.status = next;
    if (extraErr) this.lastError = extraErr;
    if (next === 'healthy') { this.restartAttempts = 0; this.lastError = ''; }
    this.mgr.emit('status', this.id, next, this.snapshot());
  }

  snapshot() {
    const cfg = this.cfg;
    return {
      id: this.id,
      name: cfg.name || this.id,
      type: cfg.type || '',
      enabled: !!cfg.enabled,
      mode: cfg.mode || '',
      status: this.status,
      pid: this.pid,
      port: cfg.port || 0,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      version: this.version || (cfg.updater && cfg.updater.currentVersion) || null,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      restartAttempts: this.restartAttempts,
      lastHealthAt: this.lastHealthAt,
      deps: cfg.requires ? this.deps : undefined,
      adminPanel: cfg.adminPanel || null,
    };
  }

  clearTimers() {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }
}

// ────────────────────────── PlatformManager ──────────────────────────

class PlatformManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./config').ConfigStore} opts.store   配置仓库
   * @param {string} opts.dataDir    %AppData%/wanneng2api
   * @param {string} [opts.shellRoot] 壳子根目录（解析 ../hub/hub.exe 等相对路径）
   * @param {object} [opts.logger]   {info,warn,error}
   * @param {boolean} [opts.allowOrphanAdopt] 预留：收养已运行实例
   */
  constructor({ store, dataDir, shellRoot = path.resolve(__dirname, '..'), logger, allowOrphanAdopt = false }) {
    super();
    this.store = store;
    this.dataDir = dataDir;
    this.shellRoot = shellRoot;
    this.allowOrphanAdopt = allowOrphanAdopt;
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.logsPlatformsDir = path.join(dataDir, 'logs', 'platforms');
    fs.mkdirSync(this.logsPlatformsDir, { recursive: true });
    this.rts = new Map();
    this._stopping = false;
    for (const p of store.platforms.platforms) {
      this.rts.set(p.id, new PlatformRuntime(p.id, p, this));
    }
    this._cleanupUpdatingResidue();
  }

  // ── .updating 残留清理（§7.2-8 / §4.6 崩溃恢复）──
  _cleanupUpdatingResidue() {
    for (const p of this.store.platforms.platforms) {
      const marker = path.join(this.dataDir, 'updates', p.id, '.updating');
      if (!fs.existsSync(marker)) continue;
      try {
        const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
        this.log.warn(`[update] 发现 ${p.id} 更新残留，尝试回滚: ${JSON.stringify(info)}`);
        if (info.backupDir && fs.existsSync(info.backupDir)) {
          this._restoreBackup(p, info);
        }
        fs.unlinkSync(marker);
      } catch (e) {
        this.log.error(`[update] ${p.id} 残留清理失败: ${e.message}`);
      }
    }
  }

  _restoreBackup(platformCfg, info) {
    const workDir = this.store.platformWorkDir(platformCfg);
    if (info.strategy === 'replace-binary' && info.binaryPath && fs.existsSync(info.backupDir)) {
      const files = fs.readdirSync(info.backupDir);
      if (files.length) {
        fs.copyFileSync(path.join(info.backupDir, files[0]), info.binaryPath);
      }
    } else if (info.strategy === 'replace-dir' && fs.existsSync(info.backupDir)) {
      this._copyTree(info.backupDir, workDir, []); // 整目录回滚
    }
  }

  _copyTree(src, dest, skipGlobs) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const rel = path.relative(src, s).replace(/\\/g, '/');
      if (skipGlobs && skipGlobs.some((g) => simpleGlobMatch(g, rel))) continue;
      if (fs.statSync(s).isDirectory()) this._copyTree(s, d, skipGlobs);
      else fs.copyFileSync(s, d);
    }
  }

  getRuntime(id) {
    return this.rts.get(id) || null;
  }

  // ── 命令解析 ──
  _resolveCommand(rt) {
    const cfg = rt.cfg;
    const run = cfg.run || {};
    const workDir = this.store.platformWorkDir(cfg);

    if (cfg.type === 'python-module') {
      const py = this._resolvePython(rt);
      const args = ['-m', run.module || cfg.id, ...(run.args || [])];
      return { command: py, args, cwd: workDir };
    }

    let binary = run.binary || '';
    if (!binary) throw new Error('platform run.binary 未配置');
    let command;
    if (path.isAbsolute(binary)) {
      command = binary;
    } else if (/^(\.\.[/\\]|\.\/)/.test(binary)) {
      command = path.resolve(this.shellRoot, binary); // 相对壳子根（如 ../hub/hub.exe）
    } else if (/[/\\]/.test(binary)) {
      command = path.join(workDir, binary);           // 相对 workDir（如 bin/xxx.exe）
    } else {
      // 裸文件名：先看 workDir 里有没有（Windows 的 spawn 不搜索 cwd，
      // 直接用裸名会 ENOENT），否则退回 PATH 查找（测试用的 node/python 等）。
      const inWorkDir = path.join(workDir, binary);
      command = fs.existsSync(inWorkDir) ? inWorkDir : binary;
    }
    return { command, args: (run.args || []).slice(), cwd: workDir };
  }

  _resolvePython(rt) {
    const run = rt.cfg.run || {};
    const py = run.pythonPath || 'bundled';
    const candidates = [];
    if (py === 'bundled') {
      // 打包后 resources/python/python.exe；开发期回落系统 python
      if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'python', 'python.exe'));
      candidates.push(path.join(this.shellRoot, 'resources', 'python', 'python.exe'));
    } else {
      candidates.push(py);
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    this.log.warn(`[loomy] 捆绑 python 未找到，回落系统 python（${py}）`);
    return 'python';
  }

  _buildEnv(rt) {
    const cfg = rt.cfg;
    const env = { ...process.env };
    // 参考 AAR backendEnv：清代理变量，防系统代理污染环回/上游
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[k];
    }
    env.NO_PROXY = '*';
    env.no_proxy = '*';
    const extra = (cfg.run && cfg.run.env) || {};
    for (const [k, v] of Object.entries(extra)) env[k] = v;
    // sub2api 依赖注入（§8.2-4）：影子进程用 manager.json sub2api 段的端口
    if (Array.isArray(cfg.requires) && cfg.requires.includes('pg')) {
      const m = this.store.manager.sub2api || {};
      env.DATABASE_URL = this.buildDatabaseUrl();
      env.PGPORT = String(m.pgPort || 5433);
    }
    if (Array.isArray(cfg.requires) && cfg.requires.includes('redis')) {
      const m = this.store.manager.sub2api || {};
      env.REDIS_HOST = '127.0.0.1';
      env.REDIS_PORT = String(m.redisPort || 6380);
    }
    return env;
  }

  // ── 健康探针 ──
  _probeHealth(url, timeoutSec) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const req = http.get(url, { timeout: Math.max(1, timeoutSec) * 1000 }, (res) => {
        res.resume(); // 排空
        done(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
    });
  }

  _scheduleHealthTimer(rt) {
    if (rt.healthTimer) clearInterval(rt.healthTimer);
    const h = rt.cfg.health || {};
    const iv = Math.max(0.5, Number(h.intervalSec) || 15) * 1000;
    rt.healthTimer = setInterval(() => this._healthTick(rt), iv);
    this._healthTick(rt);
  }

  async _healthTick(rt) {
    if (this._stopping || rt.stopping || !rt.proc) return;
    if (['stopped', 'error', 'updating'].includes(rt.status)) return;
    const h = rt.cfg.health || {};
    const ok = await this._probeHealth(h.url || `http://127.0.0.1:${rt.cfg.port}/`, Number(h.timeoutSec) || 3);
    rt.lastHealthAt = Date.now();
    if (ok) {
      rt.failCount = 0;
      rt.okCount += 1;
      const okT = Math.max(1, Number(h.okThreshold) || 1);
      if (['starting', 'degraded', 'unhealthy'].includes(rt.status) && rt.okCount >= okT) {
        rt.setStatus('healthy');
      }
    } else {
      rt.okCount = 0;
      rt.failCount += 1;
      if (rt.status === 'starting') return; // 启动宽限期内不降级
      const ft = Math.max(1, Number(h.failThreshold) || 3);
      if (rt.status === 'healthy' && rt.failCount >= ft) {
        rt.setStatus('degraded', `健康连续失败 ${rt.failCount} 次`);
      } else if (rt.status === 'degraded' && rt.failCount >= ft * 2) {
        rt.setStatus('unhealthy', `健康持续失败 ${rt.failCount} 次`);
      }
    }
  }

  /** 等待首次健康通过（start 内使用，超时返回 false 不抛错） */
  async _waitForFirstHealth(rt, timeoutSec) {
    const h = rt.cfg.health || {};
    const deadline = Date.now() + Math.max(5, timeoutSec) * 1000;
    while (Date.now() < deadline && rt.proc && !rt.stopping && !this._stopping) {
      if (await this._probeHealth(h.url || `http://127.0.0.1:${rt.cfg.port}/`, Number(h.timeoutSec) || 3)) {
        rt.failCount = 0;
        rt.okCount = Math.max(rt.okCount, 1);
        return true;
      }
      if (!rt.proc) return false; // 进程已退出，走 crash 分支
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  _startTimeoutSec(rt) {
    const cfg = rt.cfg;
    if (Array.isArray(cfg.requires) && cfg.requires.length) return 600; // sub2api 首次迁移最长 10min
    return 120;
  }

  // ── 启动 ──
  async start(id) {
    const rt = this.getRuntime(id);
    if (!rt) throw new Error(`未知平台: ${id}`);
    const cfg = rt.cfg;
    if (rt.status === 'updating') throw new Error('平台更新中，禁止启动');
    if (rt.proc && !rt.stopping) throw new Error('平台已在运行');
    if (cfg.enabled === false) throw new Error('平台已禁用，请先 enable');

    rt.stopping = false;
    rt.clearTimers();
    rt.lastError = '';
    rt.failCount = 0;
    rt.okCount = 0;

    // 0. 外部托管平台（如 magpie）：壳不启动它，只探测存活并反映到状态灯。
    //    它的生命周期由应用自身/系统托盘负责，壳无权启停。
    if (cfg.type === 'external' || cfg.managed === false) {
      rt.setStatus('starting');
      const h = cfg.health || {};
      const probe = () =>
        this._probeHealth(h.url || `http://127.0.0.1:${cfg.port}/`, Number(h.timeoutSec) || 3);
      const ok = await probe().catch(() => false);
      rt.setStatus(ok ? 'healthy' : 'unhealthy', ok ? '' : '外部服务未运行（由该应用自己启动）');
      // 外部平台没有子进程，用独立定时器轮询存活（_healthTick 依赖 rt.proc）。
      const iv = Math.max(1, Number(h.intervalSec) || 20) * 1000;
      if (rt.healthTimer) clearInterval(rt.healthTimer);
      rt.healthTimer = setInterval(async () => {
        if (rt.stopping || rt.status === 'stopped') return;
        const alive = await probe().catch(() => false);
        rt.lastHealthAt = Date.now();
        if (alive && rt.status !== 'healthy') rt.setStatus('healthy');
        else if (!alive && rt.status === 'healthy') {
          rt.setStatus('unhealthy', '外部服务已停止（由该应用自己启动）');
        }
      }, iv);
      return rt.snapshot();
    }

    // 1. 端口预检
    if (cfg.port) {
      const { free, pid } = await checkPortFree(cfg.port, rt.pid);
      if (!free) {
        const msg = `port-conflict: 端口 ${cfg.port} 已被 PID ${pid} 占用（非本平台进程）`;
        rt.setStatus('error', msg);
        throw new Error(msg);
      }
    }

    // 2. 依赖编排（sub2api: pg → redis）
    if (Array.isArray(cfg.requires) && cfg.requires.length) {
      try {
        await this._startDeps(rt);
      } catch (e) {
        rt.setStatus('error', `依赖启动失败: ${e.message}`);
        await this._stopDeps(rt).catch(() => {});
        throw e;
      }
    }

    // 3. spawn
    let cmd;
    try {
      cmd = this._resolveCommand(rt);
    } catch (e) {
      rt.setStatus('error', e.message);
      throw e;
    }
    if (cmd.command !== 'node' && cmd.command !== 'python' && !fs.existsSync(cmd.command) && /[/\\]/.test(cmd.command)) {
      const msg = `可执行文件不存在: ${cmd.command}`;
      rt.setStatus('error', msg);
      throw new Error(msg);
    }

    rt.setStatus('starting');
    rt.appendLog('manager', `spawn: "${cmd.command}" ${cmd.args.join(' ')} (cwd=${cmd.cwd})`);
    let proc;
    try {
      proc = spawn(cmd.command, cmd.args, {
        cwd: cmd.cwd,
        env: this._buildEnv(rt),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      rt.setStatus('error', `spawn 失败: ${e.message}`);
      await this._stopDeps(rt).catch(() => {});
      throw e;
    }

    rt.proc = proc;
    rt.pid = proc.pid;
    rt.startedAt = Date.now();
    this.log.info(`[platform:${id}] spawned pid=${proc.pid}`);

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { for (const line of d.split(/\r?\n/)) if (line.trim()) rt.appendLog('out', line); });
    proc.stderr.on('data', (d) => { for (const line of d.split(/\r?\n/)) if (line.trim()) rt.appendLog('err', line); });

    proc.on('error', (e) => {
      rt.appendLog('manager', `process error: ${e.message}`);
    });

    // 4. 意外退出 → 指数退避自动重启
    proc.on('exit', (code) => {
      const wasStopping = rt.stopping;
      rt.proc = null;
      rt.pid = 0;
      rt.lastExitCode = code;
      if (rt.healthTimer) { clearInterval(rt.healthTimer); rt.healthTimer = null; }
      rt.appendLog('manager', `exit code=${code} stopping=${wasStopping}`);
      if (wasStopping || this._stopping) {
        rt.setStatus('stopped');
        return;
      }
      // crash 分支
      const r = cfg.restart || {};
      const base = Math.max(0.2, Number(r.baseBackoffSec) || 2);
      const maxB = Math.max(base, Number(r.maxBackoffSec) || 300);
      const maxRetries = Number(r.maxRetries) || 0; // 0 = 无限
      if (maxRetries > 0 && rt.restartAttempts >= maxRetries) {
        rt.setStatus('error', `进程退出(code=${code})，已达最大重试次数 ${maxRetries}`);
        return;
      }
      const delay = Math.min(base * Math.pow(2, rt.restartAttempts), maxB);
      rt.restartAttempts += 1;
      rt.setStatus('error', `进程意外退出(code=${code})，${delay.toFixed(1)}s 后自动重启（第 ${rt.restartAttempts} 次）`);
      rt.restartTimer = setTimeout(() => {
        rt.restartTimer = null;
        if (rt.stopping || this._stopping) return;
        this.start(id).catch((e) => this.log.error(`[platform:${id}] 重启失败: ${e.message}`));
      }, delay * 1000);
    });

    // 5. 等待首次健康
    const ok = await this._waitForFirstHealth(rt, this._startTimeoutSec(rt));
    if (rt.proc && ok) {
      rt.setStatus('healthy');
    } else if (rt.proc && !ok) {
      rt.setStatus('unhealthy', `启动后 ${this._startTimeoutSec(rt)}s 内健康检查未通过（进程仍在，继续巡检）`);
    }
    this._scheduleHealthTimer(rt);
    return rt.snapshot();
  }

  // ── 优雅停止 ──
  async stop(id, { timeoutMs = 3000 } = {}) {
    const rt = this.getRuntime(id);
    if (!rt) throw new Error(`未知平台: ${id}`);
    if (rt.status === 'updating') throw new Error('平台更新中，禁止停止');
    // 外部托管平台不归壳管，stop 只停止探测，不碰对方进程。
    if (rt.cfg.type === 'external' || rt.cfg.managed === false) {
      rt.clearTimers();
      rt.proc = null;
      rt.pid = 0;
      rt.setStatus('stopped');
      return rt.snapshot();
    }
    rt.stopping = true;
    rt.clearTimers();

    const proc = rt.proc;
    if (proc) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        proc.once('exit', finish);
        try { proc.kill(); } catch (_e) { finish(); }
        setTimeout(async () => {
          if (!done && proc.pid) {
            rt.appendLog('manager', `优雅退出超时 ${timeoutMs}ms，taskkill 强杀进程树`);
            await taskkillTree(proc.pid);
            finish();
          }
        }, timeoutMs);
      });
    }
    rt.proc = null;
    rt.pid = 0;
    rt.startedAt = 0;
    rt.failCount = 0;
    rt.okCount = 0;

    // 依赖反序停止（server.exe → redis → pg）
    if (Array.isArray(rt.cfg.requires) && rt.cfg.requires.length) {
      await this._stopDeps(rt);
    }
    rt.stopping = false;
    if (rt.status !== 'stopped') rt.setStatus('stopped');
    return rt.snapshot();
  }

  async restart(id) {
    await this.stop(id);
    await new Promise((r) => setTimeout(r, 300)); // 让端口完全释放
    return this.start(id);
  }

  enable(id) {
    const p = this.store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    this.store.updatePlatform(id, { enabled: true });
    return { id, enabled: true };
  }

  disable(id) {
    const p = this.store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    this.store.updatePlatform(id, { enabled: false });
    const rt = this.getRuntime(id);
    if (rt && rt.proc) {
      // 异步停止，不阻塞响应
      this.stop(id).catch((e) => this.log.error(`[platform:${id}] disable 停止失败: ${e.message}`));
    }
    return { id, enabled: false };
  }

  tailLogs(id, n = 200) {
    const rt = this.getRuntime(id);
    if (!rt) throw new Error(`未知平台: ${id}`);
    return rt.ring.tail(n);
  }

  onLog(id, fn) {
    const rt = this.getRuntime(id);
    if (!rt) return () => {};
    rt.ring.on('line', fn);
    return () => rt.ring.off('line', fn);
  }

  statusList() {
    return [...this.rts.values()].map((rt) => rt.snapshot());
  }

  statusOf(id) {
    const rt = this.getRuntime(id);
    return rt ? rt.snapshot() : null;
  }

  /** 启动 autoStartPlatforms（按 manager.json 顺序） */
  async startAutoStart() {
    const list = (this.store.manager.general && this.store.manager.general.autoStartPlatforms) || [];
    const delaySec = Number(this.store.manager.general && this.store.manager.general.autoStartDelaySec) || 0;
    for (const id of list) {
      const rt = this.getRuntime(id);
      if (!rt) continue;
      if (rt.cfg.enabled === false) continue;
      if (delaySec > 0) await new Promise((r) => setTimeout(r, delaySec * 1000));
      try {
        await this.start(id);
      } catch (e) {
        this.log.error(`[platform:${id}] 自启失败: ${e.message}`);
      }
    }
  }

  /** 反序停止全部（托盘退出用） */
  async stopAll() {
    this._stopping = true;
    const ids = [...this.rts.keys()].reverse(); // platforms.json 顺序的反序
    for (const id of ids) {
      const rt = this.getRuntime(id);
      if (rt && (rt.proc || rt.status !== 'stopped')) {
        try { await this.stop(id); } catch (e) { this.log.error(`[platform:${id}] stopAll 失败: ${e.message}`); }
      }
    }
    this._stopping = false;
  }

  // ══════════════════ sub2api 依赖编排（§8）══════════════════
  //
  // PG/Redis 是影子进程：不进平台列表，状态挂在 sub2api 卡片（deps 三圆点）。
  // 目录：%AppData%/wanneng2api/deps/pg15 与 deps/redis（启用 sub2api 时部署）。

  _sub2apiPaths(rt) {
    const m = this.store.manager.sub2api || {};
    const depsDir = path.join(this.dataDir, 'deps');
    const pgBin = path.join(depsDir, 'pg15', 'bin');
    const redisBin = path.join(depsDir, 'redis');
    const dataRoot = m.dataDir ? this.store.platformWorkDir({ workDir: m.dataDir })
      : path.join(this.dataDir, 'platforms', 'sub2api');
    const pgData = path.join(dataRoot, 'pgdata');
    // 依赖可执行解析：优先 .exe（正式部署），回落 .cmd（便携 shim / 测试桩）
    const pgBinDir = pgData ? path.dirname(path.dirname(pgData)) : '';
    void pgBinDir;
    return {
      pgPort: Number(m.pgPort) || 5433,
      redisPort: Number(m.redisPort) || 6380,
      pgData,
      pgBoot: this._depResolve(path.join(pgBin, 'pg_ctl')),
      pgInit: this._depResolve(path.join(pgBin, 'initdb')),
      pgIsReady: this._depResolve(path.join(pgBin, 'pg_isready')),
      pgCreatedb: this._depResolve(path.join(pgBin, 'createdb')),
      pgPsql: this._depResolve(path.join(pgBin, 'psql')),
      redisExe: this._depResolve(path.join(redisBin, 'redis-server')),
    };
  }

  /** 依赖可执行解析：base.exe → base.cmd → null */
  _depResolve(base) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
    return null;
  }

  /** spawn 依赖程序（.cmd/.bat 需经 cmd.exe，Node ≥20 安全策略禁止直接 spawn） */
  _depSpawn(exe, args, opts = {}) {
    if (/\.(cmd|bat)$/i.test(exe)) {
      const cmdline = `"${exe}" ${args.map((a) => this._quoteArg(a)).join(' ')}`;
      return spawn(cmdline, [], {
        shell: true, windowsHide: true, stdio: opts.stdio || 'ignore',
        env: opts.env || process.env, detached: !!opts.detached,
      });
    }
    return spawn(exe, args, {
      windowsHide: true, stdio: opts.stdio || 'ignore', env: opts.env || process.env,
      detached: !!opts.detached,
    });
  }

  _ensureDbPassword() {
    const m = this.store.manager;
    m.sub2api = m.sub2api || {};
    if (!m.sub2api.dbPassword) {
      m.sub2api.dbPassword = randomHex(12);
      this.store.saveManager();
      this.log.info('[sub2api] 已生成随机数据库密码并写入 manager.json');
    }
    return m.sub2api.dbPassword;
  }

  _quoteArg(a) {
    return /[\s"]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : String(a);
  }

  _runFile(cmd, args, { timeoutMs = 60000, env } = {}) {
    // .cmd/.bat 须经 cmd.exe（Node ≥20 安全策略禁止直接 execFile）。
    // exec() 本身走 cmd /d /s /c "<整串>"，引号语义可控。
    if (/\.(cmd|bat)$/i.test(cmd)) {
      const cmdline = `"${cmd}" ${args.map((a) => this._quoteArg(a)).join(' ')}`;
      return new Promise((resolve) => {
        exec(cmdline, { windowsHide: true, timeout: timeoutMs, env: env || process.env },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      });
    }
    return new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, env: env || process.env },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
  }

  async _startDeps(rt) {
    const p = this._sub2apiPaths(rt);
    const password = this._ensureDbPassword();
    const env = { ...process.env, PGPASSWORD: password, PGDATA_STUB: p.pgData };

    // ── 1. PostgreSQL：initdb（首次）→ spawn → pg_isready 轮询 60s ──
    if (!p.pgBoot) {
      throw new Error('未找到便携 PostgreSQL（deps/pg15/bin/pg_ctl.exe），请将 PG15 免安装版部署到 deps/pg15');
    }
    if (!fs.existsSync(p.pgData)) {
      if (!p.pgInit) throw new Error('未找到 initdb（deps/pg15/bin/initdb.exe）');
      rt.appendLog('manager', '[deps/pg] 首次初始化 initdb ...');
      const pwFile = this._writePwFile(password);
      const r = await this._runFile(p.pgInit, ['-D', p.pgData, '-U', 'wanneng', '-E', 'UTF8', '-A', 'scram-sha-256',
        `--pwfile=${pwFile}`], { timeoutMs: 120000, env });
      try { fs.unlinkSync(pwFile); } catch (_e) { /* ignore */ }
      if (r.err) throw new Error(`initdb 失败: ${r.stderr || r.err.message}`);
      // 最小 postgresql.conf
      fs.appendFileSync(path.join(p.pgData, 'postgresql.conf'),
        `\nport = ${p.pgPort}\nlisten_addresses = '127.0.0.1'\nmax_connections = 50\n`);
    }
    if (!fs.existsSync(path.join(p.pgData, 'postgresql.conf'))) {
      throw new Error(`pgdata 缺少 postgresql.conf: ${p.pgData}`);
    }
    rt.appendLog('manager', `[deps/pg] spawn postgres -p ${p.pgPort}`);
    const pgProc = this._depSpawn(p.pgBoot, ['start', '-D', p.pgData, '-w', '-t', '60'], {
      stdio: 'ignore', env,
    });
    rt.deps.pg = { status: 'starting', pid: pgProc.pid };

    // pg_ctl start 在 Windows 下会 spawn postgres 子进程后退出；用 pg_isready 轮询就绪
    let pgReady = false;
    for (let i = 0; i < 60 && p.pgIsReady; i++) {
      const r = await this._runFile(p.pgIsReady, ['-h', '127.0.0.1', '-p', String(p.pgPort)], { timeoutMs: 5000, env });
      if (!r.err && /accepting connections/i.test(r.stdout || '')) { pgReady = true; break; }
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!pgReady) {
      rt.deps.pg = { status: 'unhealthy', pid: 0 };
      throw new Error('pg_isready 60s 内未就绪');
    }
    // 确保 sub2api 数据库存在
    await this._ensureDb(p, env);
    rt.deps.pg = { status: 'healthy', pid: pgProc.pid };

    // ── 2. Redis：spawn → PING 探活 30s ──
    if (!p.redisExe) {
      throw new Error('未找到便携 Redis（deps/redis/redis-server.exe），请部署到 deps/redis');
    }
    rt.appendLog('manager', `[deps/redis] spawn redis-server --port ${p.redisPort}`);
    const redisProc = this._depSpawn(p.redisExe,
      ['--port', String(p.redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
        stdio: 'ignore', env: this._buildEnv(rt),
      });
    rt.deps.redis = { status: 'starting', pid: redisProc.pid };
    let redisOk = false;
    for (let i = 0; i < 30; i++) {
      redisOk = await this._redisPing(p.redisPort);
      if (redisOk) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!redisOk) {
      rt.deps.redis = { status: 'unhealthy', pid: 0 };
      throw new Error('Redis PING 30s 内未就绪');
    }
    rt.deps.redis = { status: 'healthy', pid: redisProc.pid };
    this._depProcs = this._depProcs || new Map();
    this._depProcs.set(rt.id, { pg: pgProc, redis: redisProc, paths: p });
  }

  _writePwFile(password) {
    const f = path.join(this.dataDir, '.pgpw.tmp');
    fs.writeFileSync(f, password + '\n');
    return f;
  }

  async _ensureDb(p, env) {
    if (!p.pgPsql) return; // 无 psql 时跳过建库（真实部署必有）
    const q = await this._runFile(p.pgPsql,
      ['-h', '127.0.0.1', '-p', String(p.pgPort), '-U', 'wanneng', '-d', 'postgres', '-tAc',
        "SELECT 1 FROM pg_database WHERE datname='sub2api'"], { timeoutMs: 10000, env });
    if (!q.err && String(q.stdout).trim() !== '1' && p.pgCreatedb) {
      await this._runFile(p.pgCreatedb, ['-h', '127.0.0.1', '-p', String(p.pgPort), '-U', 'wanneng', 'sub2api'],
        { timeoutMs: 15000, env });
    }
  }

  _redisPing(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let buf = '';
      const done = (ok) => { try { sock.destroy(); } catch (_e) { /* ignore */ } resolve(ok); };
      sock.setTimeout(2000, () => done(false));
      sock.once('connect', () => sock.write('PING\r\n'));
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('+PONG')) done(true);
        else done(false);
      });
      sock.once('error', () => done(false));
    });
  }

  async _stopDeps(rt) {
    const held = this._depProcs && this._depProcs.get(rt.id);
    const p = (held && held.paths) || this._sub2apiPaths(rt);
    // 反序：redis → pg
    if (held && held.redis && held.redis.pid) {
      try { held.redis.kill(); } catch (_e) { /* ignore */ }
      rt.deps.redis = { status: 'stopped', pid: 0 };
    }
    if (p.pgBoot && fs.existsSync(p.pgData)) {
      rt.appendLog('manager', '[deps/pg] pg_ctl stop -m fast');
      await this._runFile(p.pgBoot, ['stop', '-D', p.pgData, '-m', 'fast'], { timeoutMs: 15000 });
    }
    if (held) this._depProcs.delete(rt.id);
    rt.deps.pg = { status: 'stopped', pid: 0 };
    rt.deps.redis = { status: 'stopped', pid: 0 };
  }

  /** sub2api 首次启用时生成 DATABASE_URL（供 UI 展示/校验） */
  buildDatabaseUrl() {
    const m = this.store.manager.sub2api || {};
    const password = this._ensureDbPassword();
    return `postgres://wanneng:${password}@127.0.0.1:${m.pgPort || 5433}/sub2api?sslmode=disable`;
  }

  destroy() {
    for (const rt of this.rts.values()) rt.clearTimers();
  }
}

module.exports = {
  PlatformManager,
  STATES,
  checkPortFree,
  findListeningPid,
  simpleGlobMatch,
};
