'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { TARGETS, TunnelError, targetOf, normalizeToken, parseNamedTokenInfo } = require('./targets');
const { CloudflaredProcess, redactText } = require('./cloudflared-process');
const { CloudflaredBinary } = require('./cloudflared-binary');
const { PublicApiGateway } = require('./public-api-gateway');
const { RemoteGateway } = require('./remote-gateway');
const { RemoteAuth } = require('./remote-auth');
const { RingBuffer, RotatingFileWriter } = require('../logs');

const FATAL_CODES = new Set([
  'UNKNOWN_TARGET', 'INVALID_CONFIG', 'INVALID_MODE', 'INVALID_GUARD_PORT', 'INVALID_PUBLIC_URL',
  'PUBLIC_URL_REQUIRED', 'TOKEN_REQUIRED', 'INVALID_TOKEN', 'TOKEN_INVALID', 'TOKEN_REFUSED',
  'TOKEN_VERIFICATION_REQUIRED', 'TOKEN_CHANGED', 'TOKEN_VERIFY_ACTIVE',
  'DUPLICATE_TOKEN', 'DUPLICATE_PUBLIC_URL', 'DUPLICATE_GUARD_PORT', 'API_KEY_REQUIRED', 'API_KEY_INVALID',
  'ROUTE_UNSUPPORTED', 'PLATFORM_DISABLED', 'PASSWORD_REQUIRED', 'PASSWORD_RECORD_INVALID',
  'STATIC_UI_REQUIRED', 'MANAGER_NOT_LOOPBACK', 'GUARD_PORT_BUSY', 'UNSUPPORTED_PLATFORM',
  'BINARY_HASH_MISMATCH', 'BINARY_INVALID', 'SPAWN_ERROR', 'STOP_UNCONFIRMED',
]);

function defaultHealthCheck(url, { proxy, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const options = proxy ? proxy.withAgent('tunnelRuntime', { timeout: timeoutMs }) : { timeout: timeoutMs };
    const req = mod.get(url, options, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode || 500) === 200, status: res.statusCode || 0 });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

function defaultPortCheck(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer();
    server.unref();
    server.once('error', () => reject(new TunnelError('GUARD_PORT_BUSY', `本机入口 ${host}:${port} 已被占用`, 409)));
    server.listen(port, host, () => server.close(() => resolve({ free: true })));
  });
}

class TunnelManager {
  constructor({ store, adapters, binary, remoteAuth, managerOrigin = 'http://127.0.0.1:17800',
    staticDir = '', proxy, processFactory, apiGatewayFactory, remoteGatewayFactory,
    healthCheck, localCheck, portCheck = defaultPortCheck, healthIntervalMs = 30000,
    reconnectBaseMs = 2000, reconnectMaxMs = 60000, publicRetryDelaysMs = [1000, 2000, 4000], logger } = {}) {
    if (!store || !adapters) throw new TypeError('TunnelManager 需要 store 和 adapters');
    this.store = store;
    this.adapters = adapters;
    this.proxy = proxy || require('../proxy');
    this.binary = binary || new CloudflaredBinary({ dataDir: store.dataDir, proxy: this.proxy });
    this.remoteAuth = remoteAuth || new RemoteAuth({ store });
    this.managerOrigin = managerOrigin;
    this.staticDir = staticDir;
    this.processFactory = processFactory || ((options) => new CloudflaredProcess(options));
    this.apiGatewayFactory = apiGatewayFactory || ((options) => new PublicApiGateway(options));
    this.remoteGatewayFactory = remoteGatewayFactory || ((options) => new RemoteGateway(options));
    this.healthCheck = healthCheck || ((url) => defaultHealthCheck(url, { proxy: this.proxy }));
    this.localCheck = localCheck || (async (origin) => defaultHealthCheck(`${origin}/api/overview`, { timeoutMs: 10000 }));
    this.portCheck = portCheck;
    this.healthIntervalMs = healthIntervalMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.publicRetryDelaysMs = publicRetryDelaysMs;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.runtimes = new Map();
    for (const target of TARGETS) this.runtimes.set(target.id, this._newRuntime(target));
  }

  _newRuntime(target) {
    const file = path.join(this.store.dataDir, 'logs', 'tunnels', `${target.id}.log`);
    return {
      target, generation: 0, desiredRunning: false, restoring: false, wasRunning: false,
      phase: 'stopped', stage: 'idle', process: null, gateway: null,
      publicUrl: '', startedAt: 0, lastReadyAt: 0,
      localHealth: 'unknown', publicHealth: 'unknown', lastHealthAt: 0,
      retryAttempt: 0, nextRetryAt: 0, lastError: null,
      reconnecting: false, healthInFlight: false, healthFailures: 0,
      verifyGeneration: 0, verifyingToken: false, verificationProcess: null, verificationError: null,
      reconnectTimer: null, healthTimer: null,
      ring: new RingBuffer(500), writer: new RotatingFileWriter(file),
    };
  }

  _runtime(id) {
    const target = targetOf(id);
    return this.runtimes.get(target.id);
  }

  _log(id, value) {
    const runtime = this._runtime(id);
    const secrets = this.store.secretValues();
    for (const line of String(value || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const safe = redactText(line, secrets).slice(0, 4000);
      runtime.ring.push(safe);
      runtime.writer.write(`${new Date().toISOString()} ${safe}`);
    }
  }

  snapshot() {
    return { targets: TARGETS.map((target) => this.statusOf(target.id)), binary: this.binary.status() };
  }

  statusOf(id) {
    const runtime = this._runtime(id);
    const config = this.store.get(id);
    return {
      ...config,
      configuredPublicUrl: config.publicUrl,
      name: runtime.target.name,
      kind: runtime.target.kind,
      upstreamPort: runtime.target.upstreamPort,
      phase: runtime.phase,
      stage: runtime.stage,
      publicUrl: runtime.publicUrl,
      guardUrl: `http://127.0.0.1:${config.guardPort}`,
      pid: runtime.process && runtime.process.pid ? runtime.process.pid : 0,
      startedAt: runtime.startedAt || 0,
      lastReadyAt: runtime.lastReadyAt || 0,
      localHealth: runtime.localHealth,
      publicHealth: runtime.publicHealth,
      lastHealthAt: runtime.lastHealthAt || 0,
      retryAttempt: runtime.retryAttempt,
      nextRetryAt: runtime.nextRetryAt || 0,
      lastError: runtime.lastError ? { ...runtime.lastError } : null,
      desiredRunning: runtime.desiredRunning,
      verifyingToken: runtime.verifyingToken,
      verificationError: runtime.verificationError ? { ...runtime.verificationError } : null,
    };
  }

  logs(id, tail = 200) {
    return { id, lines: this._runtime(id).ring.tail(Math.min(500, Math.max(1, Number(tail) || 200))) };
  }

  binaryStatus() { return this.binary.status(); }
  async installBinary() { return { path: await this.binary.ensure(), status: this.binary.status() }; }
  hasActiveProcesses() {
    return [...this.runtimes.values()].some((runtime) => runtime.desiredRunning
      || !!(runtime.process && runtime.process.pid)
      || !!(runtime.verificationProcess && runtime.verificationProcess.pid));
  }

  updateConfig(id, patch) {
    const runtime = this._runtime(id);
    if (runtime.verifyingToken) throw new TunnelError('TOKEN_VERIFY_ACTIVE', 'Token 正在验证，请等待验证结束', 409);
    const active = runtime.desiredRunning || ['starting', 'running', 'reconnecting', 'stopping'].includes(runtime.phase);
    if (active && Object.keys(patch).some((key) => key !== 'autoStart')) {
      throw new TunnelError('TUNNEL_ACTIVE', '请先停止隧道，再修改模式、域名、Token 或本机入口', 409);
    }
    const saved = this.store.updateTarget(id, patch);
    return { ...saved, ...this.statusOf(id) };
  }

  async setManagerPassword(currentPassword, newPassword) {
    return this.remoteAuth.setPassword(currentPassword, newPassword);
  }

  async verifyToken(id, candidateToken = '') {
    const runtime = this._runtime(id);
    if (runtime.verifyingToken) throw new TunnelError('TOKEN_VERIFY_ACTIVE', 'Token 正在验证，请等待验证结束', 409);
    if (runtime.verificationProcess) throw new TunnelError('STOP_UNCONFIRMED', '上一验证进程尚未确认停止', 409);
    if (runtime.desiredRunning || ['starting', 'running', 'reconnecting', 'stopping'].includes(runtime.phase)
      || runtime.process || runtime.gateway) {
      throw new TunnelError('TUNNEL_ACTIVE', '请先停止正式隧道，再验证 Token', 409);
    }
    const token = normalizeToken(candidateToken || this.store.getToken(id));
    const info = parseNamedTokenInfo(token);
    for (const target of TARGETS) {
      if (target.id !== id && this.store.get(target.id).mode === 'named'
        && this.store.getToken(target.id) === token) {
        throw new TunnelError('DUPLICATE_TOKEN', `${target.name} 已使用此 Named Tunnel Token`, 409);
      }
    }
    runtime.verifyGeneration++;
    const generation = runtime.verifyGeneration;
    const expectedUpdatedAt = this.store.get(id).updatedAt;
    runtime.verifyingToken = true;
    runtime.verificationError = null;
    try {
      const binary = await this.binary.ensure();
      if (runtime.verifyGeneration !== generation) throw new TunnelError('TOKEN_CHANGED', '验证已取消', 409);
      const process = this.processFactory({
        binary,
        mode: 'named',
        guardPort: 0,
        publicUrl: '',
        token,
        dataDir: path.join(this.store.dataDir, 'tunnel-verify', id),
        runtimeProxy: this._runtimeProxy(),
        startupTimeoutMs: 40000,
      });
      runtime.verificationProcess = process;
      process.on('log', (line) => this._log(id, line));
      await process.start();
      await process.stop();
      runtime.verificationProcess = null;
      if (runtime.verifyGeneration !== generation) throw new TunnelError('TOKEN_CHANGED', '验证已取消', 409);
      const saved = this.store.markTokenVerified(id, {
        token, tunnelId: info.tunnelId, expectedUpdatedAt,
      });
      runtime.verificationError = null;
      return { ok: true, verifiedAt: saved.verifiedAt, tunnelId: saved.tunnelId };
    } catch (error) {
      runtime.verificationError = { code: error.code || 'VERIFY_FAILED', message: error.message, at: Date.now() };
      throw error;
    } finally {
      runtime.verifyingToken = false;
      const process = runtime.verificationProcess;
      if (process && !process.exited) {
        try {
          await process.stop();
          runtime.verificationProcess = null;
        } catch (error) {
          runtime.verificationProcess = process;
          runtime.verificationError = {
            code: error.code || 'STOP_UNCONFIRMED', message: error.message, at: Date.now(),
          };
          throw error;
        }
      } else {
        runtime.verificationProcess = null;
      }
    }
  }

  async _stopVerificationProcess(runtime) {
    runtime.verifyGeneration++;
    runtime.verifyingToken = false;
    const process = runtime.verificationProcess;
    if (process && !process.exited) {
      try { await process.stop(); runtime.verificationProcess = null; } catch (error) {
        runtime.verificationProcess = process;
        throw error;
      }
    } else {
      runtime.verificationProcess = null;
    }
  }

  async _preflight(id, { checkPort = true } = {}) {
    const runtime = this._runtime(id);
    const config = this.store.getStartConfig(id);
    if (checkPort) await this.portCheck(config.guardPort, '127.0.0.1');
    let targetStatus = null;
    if (runtime.target.kind === 'manager') {
      if (!this.remoteAuth.passwordConfigured) throw new TunnelError('PASSWORD_REQUIRED', '请先在本机设置远程管理密码', 409);
      const manager = new URL(this.managerOrigin);
      if (!['127.0.0.1', 'localhost', '::1'].includes(manager.hostname)) {
        throw new TunnelError('MANAGER_NOT_LOOPBACK', 'Manager API 必须保持仅本机监听', 409);
      }
      const staticDir = typeof this.staticDir === 'function' ? this.staticDir() : this.staticDir;
      if (!staticDir || !fs.existsSync(staticDir)) throw new TunnelError('STATIC_UI_REQUIRED', '管理台 UI 尚未构建或挂载', 409);
      const result = await this.localCheck(this.managerOrigin);
      if (!result || result.ok === false) throw new TunnelError('TARGET_UNAVAILABLE', '本机 Manager API 尚未就绪', 503);
      targetStatus = { localHealth: 'ok' };
    } else {
      targetStatus = await this.adapters.preflight(id);
    }
    return { config, targetStatus };
  }

  async preflight(id) {
    const runtime = this._runtime(id);
    const active = runtime.desiredRunning || ['starting', 'running', 'reconnecting', 'stopping'].includes(runtime.phase);
    const { config, targetStatus } = await this._preflight(id, { checkPort: !active });
    const { token, ...safeConfig } = config;
    return { ok: true, id, config: safeConfig, ...targetStatus };
  }

  start(id, { restoring = false } = {}) {
    const runtime = this._runtime(id);
    if (runtime.phase === 'stopping') throw new TunnelError('TUNNEL_BUSY', '隧道正在停止', 409);
    if (runtime.verifyingToken) throw new TunnelError('TOKEN_VERIFY_ACTIVE', 'Token 正在验证，请等待验证结束', 409);
    if (runtime.desiredRunning || ['starting', 'running', 'reconnecting'].includes(runtime.phase)) return this.statusOf(id);
    if ((runtime.process && !runtime.process.exited) || runtime.gateway || runtime.verificationProcess) {
      throw new TunnelError('STOP_UNCONFIRMED', '上一隧道尚未确认停止，请先重试停止', 409);
    }
    runtime.generation++;
    runtime.desiredRunning = true;
    runtime.restoring = restoring;
    runtime.wasRunning = false;
    runtime.phase = 'starting';
    runtime.stage = 'preflight';
    runtime.lastError = null;
    runtime.retryAttempt = 0;
    runtime.publicUrl = '';
    runtime.localHealth = 'unknown';
    runtime.publicHealth = 'unknown';
    void this._startRun(id, runtime.generation);
    return this.statusOf(id);
  }

  startAutoStart() {
    const started = [];
    for (const config of this.store.list()) {
      if (config.autoStart) started.push(this.start(config.id, { restoring: true }));
    }
    return started;
  }

  async _startRun(id, generation) {
    const runtime = this._runtime(id);
    runtime.reconnecting = false;
    try {
      if (!this._current(id, generation)) return;
      runtime.stage = 'preflight';
      const { config, targetStatus } = await this._preflight(id);
      if (!this._current(id, generation)) return;
      runtime.localHealth = targetStatus.localHealth || 'ok';
      runtime.stage = 'downloading';
      const binary = await this.binary.ensure();
      if (!this._current(id, generation)) return;
      runtime.stage = 'gateway';
      const gatewayOptions = { targetId: id, adapters: this.adapters, port: config.guardPort, host: '127.0.0.1' };
      runtime.gateway = runtime.target.kind === 'manager'
        ? this.remoteGatewayFactory({ auth: this.remoteAuth, managerOrigin: this.managerOrigin, publicUrl: config.publicUrl, ...gatewayOptions })
        : this.apiGatewayFactory(gatewayOptions);
      await runtime.gateway.listen();
      if (!this._current(id, generation)) return;
      runtime.stage = 'spawning';
      runtime.process = this.processFactory({
        binary,
        mode: config.mode,
        guardPort: config.guardPort,
        publicUrl: config.mode === 'named' ? config.publicUrl : '',
        token: config.token,
        dataDir: path.join(this.store.dataDir, 'tunnel-runtime', id),
        runtimeProxy: this._runtimeProxy(),
      });
      const process = runtime.process;
      process.on('log', (line) => this._log(id, line));
      process.on('exit', (info) => this._onProcessExit(id, generation, process, info));
      runtime.stage = 'registering';
      await process.start();
      if (!this._current(id, generation)) return;
      runtime.publicUrl = process.publicUrl || config.publicUrl;
      if (runtime.target.kind === 'manager' && runtime.gateway.setPublicUrl) runtime.gateway.setPublicUrl(runtime.publicUrl);
      runtime.stage = 'checking-public';
      let publicResult = null;
      for (let attempt = 0; attempt <= this.publicRetryDelaysMs.length; attempt++) {
        publicResult = await this.healthCheck(`${runtime.publicUrl}/__wanneng_tunnel_health`);
        if (publicResult && publicResult.ok) break;
        if (attempt < this.publicRetryDelaysMs.length) {
          await new Promise((resolve) => setTimeout(resolve, this.publicRetryDelaysMs[attempt]));
        }
        if (!this._current(id, generation)) return;
      }
      if (!publicResult || !publicResult.ok) {
        const detail = publicResult && publicResult.status ? `HTTP ${publicResult.status}` : '网络连接失败';
        throw new TunnelError('PUBLIC_HEALTH_FAILED', `公网地址尚未通过健康验证（${detail}）`, 502);
      }
      if (!this._current(id, generation)) return;
      runtime.phase = 'running';
      runtime.stage = 'idle';
      runtime.wasRunning = true;
      runtime.restoring = false;
      runtime.publicHealth = 'ok';
      runtime.lastHealthAt = Date.now();
      runtime.startedAt = runtime.startedAt || Date.now();
      runtime.lastReadyAt = Date.now();
      runtime.retryAttempt = 0;
      runtime.healthFailures = 0;
      runtime.lastError = null;
      this._log(id, `隧道已上线: ${runtime.publicUrl}`);
      this._scheduleHealth(id, generation);
    } catch (error) {
      await this._handleStartError(id, generation, error);
    }
  }

  _runtimeProxy() {
    const config = this.proxy.config();
    return config.enabled && config.scopes.tunnelRuntime && this.proxy.validProxyUrl(config.url) ? config.url : '';
  }

  _current(id, generation) {
    const runtime = this._runtime(id);
    return runtime.generation === generation && runtime.desiredRunning;
  }

  async _handleStartError(id, generation, error) {
    const runtime = this._runtime(id);
    if (runtime.generation !== generation) return;
    this._log(id, `${error.code || 'START_FAILED'}: ${error.message}`);
    const canRetry = runtime.desiredRunning && !FATAL_CODES.has(error.code)
      && (runtime.wasRunning || runtime.restoring);
    try {
      await this._cleanupAttempt(runtime);
    } catch (cleanupError) {
      runtime.desiredRunning = false;
      runtime.phase = 'error';
      runtime.stage = 'idle';
      runtime.publicHealth = 'failed';
      runtime.lastError = { code: cleanupError.code || 'STOP_UNCONFIRMED', message: cleanupError.message, at: Date.now() };
      this._log(id, `清理旧隧道失败，已阻断新实例: ${cleanupError.message}`);
      return;
    }
    if (runtime.generation !== generation) return;
    runtime.lastError = { code: error.code || 'START_FAILED', message: error.message, at: Date.now() };
    if (canRetry) this._scheduleReconnect(id, generation, error, true);
    else {
      runtime.desiredRunning = false;
      runtime.phase = 'error';
      runtime.stage = 'idle';
      runtime.publicHealth = 'failed';
    }
  }

  async _cleanupAttempt(runtime) {
    const process = runtime.process;
    const gateway = runtime.gateway;
    this._clearHealth(runtime);
    let stopError = null;
    if (process && !process.exited) {
      try { await process.stop(); } catch (error) {
        stopError = error;
        this._log(runtime.target.id, `停止旧隧道失败: ${error.message}`);
      }
    }
    // 无论停止是否成功都先关闭本机入口，切断旧公网 URL 的后续流量。
    if (gateway) {
      try {
        await gateway.close();
        runtime.gateway = null;
      } catch (error) {
        this._log(runtime.target.id, `关闭本机入口失败: ${error.message}`);
        runtime.gateway = gateway;
        if (!stopError) stopError = error;
      }
    } else {
      runtime.gateway = null;
    }
    if (stopError) {
      runtime.process = process && !process.exited ? process : null;
      throw stopError;
    }
    runtime.process = null;
  }

  _onProcessExit(id, generation, process, info) {
    const runtime = this._runtime(id);
    if (runtime.generation !== generation || runtime.process !== process || !runtime.desiredRunning) return;
    runtime.process = null;
    runtime.lastError = { code: 'PROCESS_EXIT', message: `cloudflared 意外退出（code=${info.code}）`, at: Date.now() };
    this._log(id, runtime.lastError.message);
    this._scheduleReconnect(id, generation, runtime.lastError);
  }

  _scheduleReconnect(id, generation, error, cleaned = false) {
    const runtime = this._runtime(id);
    if (!this._current(id, generation) || runtime.reconnecting) return;
    runtime.reconnecting = true;
    runtime.phase = 'reconnecting';
    runtime.stage = 'idle';
    runtime.publicHealth = 'failed';
    if (this.store.get(id).mode === 'quick') runtime.publicUrl = '';
    void (async () => {
      try {
        if (!cleaned) await this._cleanupAttempt(runtime);
        if (!this._current(id, generation)) return;
        runtime.retryAttempt++;
        const base = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.max(0, runtime.retryAttempt - 1)));
        const delay = Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4)));
        runtime.nextRetryAt = Date.now() + delay;
        runtime.reconnectTimer = setTimeout(() => {
          runtime.reconnectTimer = null;
          runtime.nextRetryAt = 0;
          void this._startRun(id, generation);
        }, delay);
      } catch (cleanupError) {
        runtime.desiredRunning = false;
        runtime.phase = 'error';
        runtime.stage = 'idle';
        runtime.lastError = { code: cleanupError.code || 'STOP_UNCONFIRMED', message: cleanupError.message, at: Date.now() };
        this._log(id, `重连清理失败，已阻断新实例: ${cleanupError.message}`);
      }
    })();
  }

  _scheduleHealth(id, generation) {
    const runtime = this._runtime(id);
    this._clearHealth(runtime);
    runtime.healthTimer = setInterval(() => void this._healthTick(id, generation), this.healthIntervalMs);
  }

  async _healthTick(id, generation) {
    const runtime = this._runtime(id);
    if (!this._current(id, generation) || runtime.phase !== 'running' || runtime.healthInFlight) return;
    runtime.healthInFlight = generation;
    try {
      try {
        const local = runtime.target.kind === 'manager'
          ? await this.localCheck(this.managerOrigin)
          : await this.adapters.preflight(id);
        if (!this._current(id, generation) || runtime.phase !== 'running') return;
        runtime.localHealth = (local && (local.localHealth || (local.ok === false ? 'failed' : 'ok'))) || 'ok';
      } catch {
        if (!this._current(id, generation) || runtime.phase !== 'running') return;
        runtime.localHealth = 'failed';
      }
      let result = null;
      try { result = await this.healthCheck(`${runtime.publicUrl}/__wanneng_tunnel_health`); } catch { result = null; }
      if (!this._current(id, generation) || runtime.phase !== 'running') return;
      runtime.lastHealthAt = Date.now();
      if (result && result.ok) {
        runtime.healthFailures = 0;
        runtime.publicHealth = 'ok';
      } else {
        runtime.healthFailures++;
        runtime.publicHealth = 'degraded';
        if (runtime.healthFailures >= 3) this._scheduleReconnect(id, generation, new TunnelError('PUBLIC_HEALTH_FAILED', '公网健康检查连续失败', 502));
      }
    } finally {
      if (runtime.healthInFlight === generation) runtime.healthInFlight = false;
    }
  }

  _clearHealth(runtime) {
    if (runtime.healthTimer) clearInterval(runtime.healthTimer);
    runtime.healthTimer = null;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
    runtime.nextRetryAt = 0;
  }

  async stop(id) {
    const runtime = this._runtime(id);
    runtime.generation++;
    runtime.desiredRunning = false;
    runtime.restoring = false;
    runtime.wasRunning = false;
    runtime.phase = 'stopping';
    runtime.stage = 'idle';
    runtime.reconnecting = false;
    this._clearHealth(runtime);
    const process = runtime.process;
    let stopError = null;
    if (process && !process.exited) {
      try {
        await process.stop();
        runtime.process = null;
      } catch (error) {
        stopError = error;
        runtime.process = process;
      }
    } else {
      runtime.process = null;
    }
    if (runtime.gateway) {
      const gateway = runtime.gateway;
      try {
        await gateway.close();
        runtime.gateway = null;
      } catch (error) {
        runtime.gateway = gateway;
        if (!stopError) stopError = error;
      }
    }
    runtime.publicUrl = '';
    runtime.publicHealth = 'unknown';
    runtime.localHealth = 'unknown';
    if (stopError) {
      runtime.phase = 'error';
      runtime.lastError = { code: stopError.code || 'STOP_FAILED', message: stopError.message, at: Date.now() };
      throw stopError;
    }
    runtime.phase = 'stopped';
    runtime.stage = 'idle';
    runtime.lastError = null;
    runtime.startedAt = 0;
    return this.statusOf(id);
  }

  async stopAll() {
    const verificationResults = await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => this._stopVerificationProcess(runtime)),
    );
    const results = await Promise.allSettled(TARGETS.map((target) => this.stop(target.id)));
    for (const runtime of this.runtimes.values()) runtime.writer.close();
    const failed = [...verificationResults, ...results].find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

module.exports = { TunnelManager, defaultHealthCheck, defaultPortCheck, FATAL_CODES };
