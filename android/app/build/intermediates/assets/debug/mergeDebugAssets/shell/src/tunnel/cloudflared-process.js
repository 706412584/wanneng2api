'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { TunnelError } = require('./targets');

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const REGISTERED = /\bRegistered tunnel connection\b/;
const TOKEN_ERROR = /provided.*token.*not valid|invalid tunnel token|failed to parse tunnel token/i;
const USAGE_ERROR = /incorrect usage|flag provided but not defined|unknown flag|unknown command/i;
const SERVER_REFUSAL = /unauthorized|forbidden|access denied|authentication failed|connection refused by server/i;

function buildArgs({ mode, guardPort, configPath }) {
  const args = ['--no-autoupdate', '--config', configPath, 'tunnel', '--metrics', '127.0.0.1:0', '--protocol', 'http2'];
  if (mode === 'quick') args.push('--url', `http://127.0.0.1:${guardPort}`);
  else if (mode === 'named') args.push('run');
  else throw new TunnelError('INVALID_MODE', '隧道模式只能是 quick 或 named');
  return args;
}

function buildEnv(base, directory, mode, token, runtimeProxy = '') {
  const env = { ...(base || {}) };
  for (const key of Object.keys(env)) {
    if (/^(TUNNEL_|CLOUDFLARED_)/i.test(key) || /_PROXY$/i.test(key)) delete env[key];
  }
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.XDG_CONFIG_HOME = directory;
  env.TMPDIR = directory;
  env.NO_PROXY = '127.0.0.1,localhost';
  env.no_proxy = env.NO_PROXY;
  if (runtimeProxy) {
    env.HTTPS_PROXY = runtimeProxy;
    env.HTTP_PROXY = runtimeProxy;
    env.https_proxy = runtimeProxy;
    env.http_proxy = runtimeProxy;
  }
  if (mode === 'named') env.TUNNEL_TOKEN = token;
  return env;
}

function redactText(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[已隐藏]');
  return text
    .replace(/([?&](?:k|key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/(authorization:\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/((?:x-api-key|x-goog-api-key|cookie):\s*)[^\r\n]+/gi, '$1[已隐藏]');
}

class CloudflaredProcess extends EventEmitter {
  constructor({ binary, mode, guardPort, publicUrl = '', token = '', dataDir,
    spawnFn = spawn, killTree, env = process.env, runtimeProxy = '',
    startupTimeoutMs = 40000, stopTimeoutMs = 8000 } = {}) {
    super();
    if (!binary || !dataDir) throw new TypeError('CloudflaredProcess 需要 binary 和 dataDir');
    this.binary = binary;
    this.mode = mode;
    this.guardPort = guardPort;
    this.publicUrl = publicUrl;
    this.token = token;
    this.dataDir = dataDir;
    this.spawnFn = spawnFn;
    this.killTree = killTree || require('../platform-manager').taskkillTree;
    this.baseEnv = env;
    this.runtimeProxy = runtimeProxy;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.child = null;
    this.pid = 0;
    this.exited = false;
    this.expectedExit = false;
    this.exitInfo = null;
    this._logWindow = '';
    this._partialLine = '';
    this._refusals = 0;
    this._ready = false;
    this._settled = false;
    this._stopPromise = null;
  }

  async start() {
    if (this.child) throw new TunnelError('ALREADY_STARTED', 'cloudflared 已启动', 409);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(this.dataDir, 'config.yml');
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '{}\n', { mode: 0o600, flag: 'wx' });
    const args = buildArgs({ mode: this.mode, guardPort: this.guardPort, configPath });
    const env = buildEnv(this.baseEnv, this.dataDir, this.mode, this.token, this.runtimeProxy);
    let startupResolve;
    let startupReject;
    const startup = new Promise((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
    this._startupResolve = startupResolve;
    this._startupReject = startupReject;
    try {
      this.child = this.spawnFn(this.binary, args, {
        cwd: this.dataDir,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new TunnelError('SPAWN_ERROR', `cloudflared 无法启动: ${error.message}`, 500);
    }
    this.pid = this.child.pid || 0;
    this._args = args;
    this.child.stdout.on('data', (data) => this._onData(data));
    this.child.stderr.on('data', (data) => this._onData(data));
    this.child.once('error', (error) => {
      this._failStart('SPAWN_ERROR', `cloudflared 无法启动: ${error.message}`);
      if (!this.child.pid) this._onExit(null, null);
    });
    this.child.once('exit', (code, signal) => this._onExit(code, signal));
    this._startupTimer = setTimeout(() => {
      this._failStart('START_TIMEOUT', 'cloudflared 建立连接超时', 504);
      void this.stop().catch(() => {});
    }, this.startupTimeoutMs);
    try {
      await startup;
      return this;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  _onData(data) {
    const raw = String(data || '');
    this.emit('log', redactText(raw, [this.token]));
    if (this.exited) return;
    this._logWindow = (this._logWindow + raw).slice(-65536);
    const quickUrl = this._logWindow.match(QUICK_URL)?.[0] || '';
    if (quickUrl && this.mode === 'quick') this.publicUrl = quickUrl;
    if (TOKEN_ERROR.test(this._logWindow)) {
      this._failStart('TOKEN_INVALID', 'Cloudflare Tunnel Token 格式无效');
      return;
    }
    if (USAGE_ERROR.test(this._logWindow)) {
      this._failStart('SPAWN_ERROR', 'cloudflared 参数与当前版本不兼容');
      return;
    }
    if (!this._ready && SERVER_REFUSAL.test(raw)) this._refusals++;
    if (!this._ready && this._refusals >= 3) {
      this._failStart('TOKEN_REFUSED', 'Cloudflare 持续拒绝此 Tunnel Token');
      return;
    }
    const registered = REGISTERED.test(this._logWindow);
    if (!this._ready && registered && (this.mode === 'named' || !!this.publicUrl)) {
      this._ready = true;
      this._settled = true;
      clearTimeout(this._startupTimer);
      this._startupResolve(this.publicUrl);
      this.emit('ready', this.publicUrl);
    }
  }

  _failStart(code, message, statusCode = 400) {
    if (this._settled) return;
    this._settled = true;
    clearTimeout(this._startupTimer);
    this._startupReject(new TunnelError(code, message, statusCode));
  }

  _onExit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this._startupTimer);
    this.exitInfo = { code, signal, expected: this.expectedExit };
    if (!this._settled) {
      this._failStart(this.expectedExit ? 'START_ABORTED' : 'EARLY_EXIT',
        this.expectedExit ? 'cloudflared 启动已取消' : 'cloudflared 在就绪前退出', 502);
    }
    this.emit('exit', this.exitInfo);
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stop();
    try { return await this._stopPromise; } catch (error) {
      this._stopPromise = null;
      throw error;
    }
  }

  async _stop() {
    this.expectedExit = true;
    clearTimeout(this._startupTimer);
    if (!this.child || this.exited) return;
    if (!this._settled) this._failStart('START_ABORTED', 'cloudflared 启动已取消', 409);
    let onExit;
    const exited = new Promise((resolve) => {
      onExit = resolve;
      this.once('exit', onExit);
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TunnelError('STOP_UNCONFIRMED', '无法确认 cloudflared 已停止', 500)), this.stopTimeoutMs);
    });
    try {
      await this.killTree(this.pid, { graceMs: Math.min(2000, this.stopTimeoutMs) });
      await Promise.race([exited, timeout]);
    } finally {
      clearTimeout(timer);
      this.removeListener('exit', onExit);
    }
  }
}

module.exports = { CloudflaredProcess, buildArgs, buildEnv, redactText, QUICK_URL, REGISTERED };
