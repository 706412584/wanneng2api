'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { TunnelError } = require('./targets');

const CLOUDFLARED_VERSION = '2026.10.6';
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const ASSETS = Object.freeze({
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f' },
  'win32-arm64': { asset: 'cloudflared-windows-amd64.exe', sha256: 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f' },
  'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: '1d356dac769d0dbf62ebe588c4034824bbff98d5790c2f844cc99e0e2f57462d' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', sha256: '0ae0e179475b2c77651a718d2b376e0151f4fca5954702a84f02843a4d5fcac0' },
});
const RETRYABLE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']);

function assetFor(platform = process.platform, arch = process.arch) {
  const spec = ASSETS[`${platform}-${arch}`];
  if (!spec) throw new TunnelError('UNSUPPORTED_PLATFORM', `当前系统 ${platform}-${arch} 暂无可核验的 cloudflared 资产`, 501);
  return { ...spec };
}

function executableName(platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CloudflaredBinary {
  constructor({ dataDir, proxy, platform = process.platform, arch = process.arch,
    download, hashFile = sha256File, spawn = spawnSync, sleepFn = sleep, baseUrl } = {}) {
    if (!dataDir) throw new TypeError('CloudflaredBinary 需要 dataDir');
    this.platform = platform;
    this.arch = arch;
    this.spec = assetFor(platform, arch);
    this.directory = path.join(dataDir, 'bin', 'cloudflared', CLOUDFLARED_VERSION);
    this.binaryPath = path.join(this.directory, executableName(platform));
    this.proxy = proxy || require('../proxy');
    this.download = download || this._downloadOnce.bind(this);
    this.hashFile = hashFile;
    this.spawn = spawn;
    this.sleep = sleepFn;
    this.baseUrl = (baseUrl || `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`).replace(/\/+$/, '');
    this._ensurePromise = null;
    this._state = {
      version: CLOUDFLARED_VERSION,
      installed: fs.existsSync(this.binaryPath),
      verified: false,
      downloading: false,
      received: 0,
      total: null,
      error: '',
      path: this.binaryPath,
    };
  }

  status() {
    return { ...this._state, installed: fs.existsSync(this.binaryPath), asset: this.spec.asset };
  }

  async ensure() {
    if (this._ensurePromise) return this._ensurePromise;
    this._ensurePromise = (async () => {
      if (await this._valid(this.binaryPath)) {
        this._state = { ...this._state, installed: true, verified: true, error: '' };
        return this.binaryPath;
      }
      return this._install();
    })().finally(() => { this._ensurePromise = null; });
    return this._ensurePromise;
  }

  async _valid(file) {
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
      if ((await this.hashFile(file)).toLowerCase() !== this.spec.sha256) return false;
      const probe = this.spawn(file, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      return !!probe && probe.status === 0;
    } catch { return false; }
  }

  async _install() {
    this._state = { ...this._state, downloading: true, received: 0, total: null, error: '' };
    fs.mkdirSync(this.directory, { recursive: true });
    const temp = `${this.binaryPath}.download-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const url = `${this.baseUrl}/${this.spec.asset}`;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.download(url, temp, (received, total = null) => {
            this._state.received = received;
            this._state.total = total;
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
          if (attempt === 3 || !RETRYABLE.has(error && error.code)) throw error;
          await this.sleep(200 * (2 ** (attempt - 1)));
        }
      }
      if (lastError) throw lastError;
      if ((await this.hashFile(temp)).toLowerCase() !== this.spec.sha256) {
        throw new TunnelError('BINARY_HASH_MISMATCH', 'cloudflared 下载文件 SHA-256 不匹配，已拒绝执行', 502);
      }
      if (this.platform !== 'win32') fs.chmodSync(temp, 0o755);
      fs.rmSync(this.binaryPath, { force: true });
      fs.renameSync(temp, this.binaryPath);
      if (!await this._valid(this.binaryPath)) {
        throw new TunnelError('BINARY_INVALID', 'cloudflared 校验或 --version 验证失败', 502);
      }
      this._state = { ...this._state, installed: true, verified: true, downloading: false, error: '' };
      return this.binaryPath;
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
      try { if (fs.existsSync(this.binaryPath) && !await this._valid(this.binaryPath)) fs.rmSync(this.binaryPath, { force: true }); } catch { /* ignore */ }
      this._state = {
        ...this._state,
        installed: fs.existsSync(this.binaryPath),
        verified: false,
        downloading: false,
        error: error && error.code === 'BINARY_HASH_MISMATCH' ? error.message : `cloudflared 下载或校验失败: ${error.message}`,
      };
      throw error instanceof TunnelError ? error : new TunnelError('BINARY_DOWNLOAD_FAILED', this._state.error, 502);
    }
  }

  async _downloadOnce(url, destination, onProgress) {
    let redirects = 0;
    const visit = async (current) => {
      if (new URL(current).protocol !== 'https:') throw new TunnelError('BINARY_DOWNLOAD_FAILED', 'cloudflared 下载只允许 HTTPS', 502);
      const response = await new Promise((resolve, reject) => {
        const req = https.get(current, this.proxy.withAgent('tunnelDownload', { timeout: 30000 }), (res) => resolve(res));
        req.on('timeout', () => req.destroy(Object.assign(new Error('下载超时'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
      });
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (++redirects > 5) throw Object.assign(new Error('cloudflared 下载重定向过多'), { code: 'TOO_MANY_REDIRECTS' });
        return visit(new URL(response.headers.location, current).toString());
      }
      if (status !== 200) {
        response.resume();
        throw Object.assign(new Error(`cloudflared 下载返回 HTTP ${status}`), { code: `HTTP_${status}` });
      }
      const total = Number(response.headers['content-length']) || null;
      if (total && total > MAX_DOWNLOAD_BYTES) {
        response.destroy(new Error('cloudflared 下载文件超过大小限制'));
        throw new TunnelError('BINARY_DOWNLOAD_FAILED', 'cloudflared 下载文件超过大小限制', 502);
      }
      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('cloudflared 下载文件超过大小限制'));
          onProgress(received, total);
          callback(null, chunk);
        },
      });
      response.on('aborted', () => response.destroy(Object.assign(new Error('下载中断'), { code: 'ECONNRESET' })));
      try {
        await pipeline(response, counter, fs.createWriteStream(destination, { flags: 'wx' }));
        const fd = fs.openSync(destination, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } finally {
        response.destroy();
      }
    };
    return visit(url);
  }
}

module.exports = { CloudflaredBinary, CLOUDFLARED_VERSION, ASSETS, assetFor, sha256File };
