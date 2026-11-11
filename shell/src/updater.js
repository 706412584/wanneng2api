'use strict';
/**
 * updater.js — 平台远程更新（DESIGN.md §7）
 *
 * check: GitHub releases/latest → assetPattern 匹配 → semver 比较
 * apply: 下载(.part 防半包) → 可选 sha256 → updating → stop → 备份
 *        → replace-binary / replace-dir(preserveGlobs 保护数据) → start
 *        → 60s 健康验证 → 失败自动回滚备份并告警
 * .updating 残留：PlatformManager 构造时清理（崩溃恢复）。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { simpleGlobMatch } = require('./platform-manager');

const HEALTH_VERIFY_SEC = 60;

// release 元数据缓存时长：未登录 GitHub 限额只有 60 次/小时，
// 而更新中心会为每个平台各查一次；缓存后反复点击不再烧额度。
const RELEASE_CACHE_MS = 30 * 60 * 1000;

function semverParts(v) {
  const m = String(v || '0.0.0').trim().replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(latest, current) {
  const a = semverParts(latest);
  const b = semverParts(current);
  if (!a) return false;
  if (!b) return true; // 当前版本未知 → 有 release 就提示
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** 从 asset 名里提取版本号（如 workbuddy2api-v1.2.10-windows-amd64.exe → 1.2.10） */
function versionFromAsset(name) {
  const m = String(name).match(/v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/);
  return m ? m[1] : null;
}

class PlatformUpdater {
  /**
   * @param {object} opts
   * @param {import('./platform-manager').PlatformManager} opts.manager
   * @param {import('./config').ConfigStore} opts.store
   * @param {string} opts.dataDir
   * @param {object} [opts.logger]
   */
  constructor({ manager, store, dataDir, logger }) {
    this.manager = manager;
    this.store = store;
    this.dataDir = dataDir;
    this.log = logger || { info: () => {}, warn: () => {}, error: () => {} };
    this.busy = new Set(); // 正在 apply 的平台
    this._releaseCache = new Map(); // repo -> { at, data }
  }

  updatesDir(id) {
    return path.join(this.dataDir, 'updates', id);
  }

  // ── §7.1 检查 ──
  async check(id) {
    const p = this.store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    const u = p.updater || {};
    if (!u.repo) {
      return { id, checked: false, reason: '未配置 updater.repo（本地平台无远程源）', current: this.currentVersion(p) };
    }
    const latest = await this._fetchLatestRelease(u.repo, this.store.manager.update && this.store.manager.update.githubToken);
    const assets = (latest.assets || []).map((a) => a.name);
    let asset = null;
    if (u.assetPattern) {
      const rx = new RegExp(u.assetPattern, 'i');
      asset = (latest.assets || []).find((a) => rx.test(a.name)) || null;
    } else if (latest.assets && latest.assets.length) {
      asset = latest.assets[0];
    }
    const latestVersion = (asset && versionFromAsset(asset.name)) || String(latest.tag_name || '').replace(/^v/i, '');
    const current = this.currentVersion(p);
    const hasUpdate = !!asset && isNewerVersion(latestVersion, current);
    return {
      id,
      checked: true,
      current,
      latest: latestVersion || latest.tag_name,
      tagName: latest.tag_name,
      hasUpdate,
      assetUrl: asset ? asset.browser_download_url : null,
      assetName: asset ? asset.name : null,
      assetSize: asset ? asset.size : null,
      sha256: asset ? this._assetDigest(latest, asset.name) : null,
      notes: latest.body || '',
      publishedAt: latest.published_at || null,
      allAssets: assets,
    };
  }

  _assetDigest(release, assetName) {
    // release body 中的 `sha256: <hex>` 约定（若上游提供）
    const body = String(release.body || '');
    const m = body.match(new RegExp(`${assetName}[^\\n]*sha256[:= ]+([a-fA-F0-9]{64})`))
      || body.match(/sha256[:= ]+([a-fA-F0-9]{64})/i);
    return m ? m[1].toLowerCase() : null;
  }

  currentVersion(p) {
    const rt = this.manager.getRuntime(p.id);
    if (rt && rt.version) return rt.version;
    return (p.updater && p.updater.currentVersion) || null;
  }

  /**
   * 查 GitHub 最新 release。
   *
   * 未配置 token 时限额只有 60 次/小时，而更新中心会为每个平台各查一次，
   * 几轮下来就会耗尽（表现为"除了没配 repo 的，其余全部检测失败"）。
   * 因此：
   *   - 成功结果缓存 30 分钟，反复点「检查更新」不再烧限额；
   *   - 403 时把重置时间带进错误信息，让用户知道什么时候能再试。
   */
  _fetchLatestRelease(repo, token) {
    const now = Date.now();
    const cached = this._releaseCache && this._releaseCache.get(repo);
    if (cached && now - cached.at < RELEASE_CACHE_MS) {
      return Promise.resolve(cached.data);
    }
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'wanneng2api-shell',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 404) { res.resume(); return reject(new Error(`仓库无 release: ${repo}`)); }
        if (res.statusCode === 403) {
          // x-ratelimit-reset 是 Unix 秒
          const reset = Number(res.headers['x-ratelimit-reset'] || 0);
          const when = reset ? new Date(reset * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';
          res.resume();
          // 有旧缓存就先给旧的，避免界面直接变红
          if (cached) return resolve(cached.data);
          return reject(new Error(
            token
              ? 'GitHub API 限流（token 也受限）' + (when ? `，约 ${when} 重置` : '')
              : `GitHub API 未登录限额已用尽（60 次/小时）${when ? `，约 ${when} 重置` : ''}；在「设置」里填 GitHub Token 可提升到 5000 次/小时`,
          ));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub API ${res.statusCode}`)); }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { buf += d; });
        res.on('end', () => {
          try {
            const data = JSON.parse(buf);
            if (!this._releaseCache) this._releaseCache = new Map();
            this._releaseCache.set(repo, { at: Date.now(), data });
            resolve(data);
          } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API 超时')); });
      req.on('error', reject);
    });
  }

  // ── §7.2 / §7.3 应用 ──
  async apply(id, checkInfo) {
    const p = this.store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    if (this.busy.has(id)) throw new Error('该平台正在更新中');
    const rt = this.manager.getRuntime(id);
    if (!rt) throw new Error(`未知平台: ${id}`);
    if (rt.status === 'updating') throw new Error('平台已在更新流程中');

    const info = checkInfo || await this.check(id);
    if (!info.checked || !info.hasUpdate || !info.assetUrl) {
      throw new Error(`无可用更新（current=${info.current}, latest=${info.latest}）`);
    }

    const strategy = (p.updater && p.updater.strategy) || 'replace-binary';
    const updDir = path.join(this.updatesDir(id), String(info.latest).replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(updDir, { recursive: true });
    const marker = path.join(this.updatesDir(id), '.updating');

    this.busy.add(id);
    const setStatus = (s, err) => { rt.setStatus(s, err || ''); this.manager.emit('update-progress', { id, status: s }); };
    try {
      // 1. 下载（.part 防半包）
      setStatus('updating', '');
      rt.appendLog('manager', `[update] 下载 ${info.assetUrl}`);
      const dlPath = await this._download(info.assetUrl, path.join(updDir, path.basename(info.assetUrl) + '.part'));

      // 2. 可选 sha256 校验
      if (info.sha256) {
        const actual = await this._sha256File(dlPath);
        if (actual !== info.sha256.toLowerCase()) {
          throw new Error(`sha256 校验失败: expect=${info.sha256} actual=${actual}`);
        }
      }

      fs.writeFileSync(marker, JSON.stringify({
        id, version: info.latest, strategy, ts: Date.now(),
      }));

      // 3. stop 平台
      if (rt.proc) await this.manager.stop(id);

      // 4. 备份
      const backupDir = path.join(this.updatesDir(id), 'backups', String(Date.now()));
      fs.mkdirSync(backupDir, { recursive: true });
      const manifest = { id, version: info.latest, strategy, backupDir };

      let installed;
      if (strategy === 'replace-binary') {
        installed = await this._replaceBinary(p, dlPath, backupDir);
      } else {
        installed = await this._replaceDir(p, dlPath, updDir, backupDir);
      }
      manifest.binaryPath = installed.binaryPath || '';
      fs.writeFileSync(marker, JSON.stringify(manifest));

      // 5. start + 60s 健康验证
      rt.appendLog('manager', `[update] 安装完成，重启验证（≤${HEALTH_VERIFY_SEC}s）`);
      try {
        await this.manager.start(id);
      } catch (e) {
        throw new Error(`更新后启动失败: ${e.message}`);
      }
      const healthy = await this._waitHealthy(rt, HEALTH_VERIFY_SEC);
      if (!healthy) {
        throw new Error(`更新后 ${HEALTH_VERIFY_SEC}s 健康验证未通过`);
      }

      // 6. 成功：登记版本，清理旧备份
      this.store.updatePlatform(id, { updater: { ...(p.updater || {}), currentVersion: info.latest } });
      if (rt.version !== undefined) rt.version = info.latest;
      this._pruneBackups(id, Number(this.store.manager.update && this.store.manager.update.keepBackups) || 3);
      try { fs.unlinkSync(marker); } catch (_e) { /* ignore */ }
      rt.setStatus('healthy');
      rt.appendLog('manager', `[update] 更新成功 → ${info.latest}`);
      return { id, ok: true, version: info.latest, rolledBack: false };
    } catch (e) {
      // 7. 失败 → 回滚
      let rolledBack = false;
      rt.appendLog('manager', `[update] 失败: ${e.message}，尝试回滚`);
      try {
        const raw = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
        const manifest = raw ? JSON.parse(raw) : null;
        if (manifest && manifest.backupDir && fs.existsSync(manifest.backupDir)) {
          if (rt.proc) { await this.manager.stop(id).catch(() => {}); }
          this._restore(manifest);
          await this.manager.start(id);
          rolledBack = true;
        }
      } catch (re) {
        rt.appendLog('manager', `[update] 回滚也失败: ${re.message}`);
      }
      try { fs.unlinkSync(marker); } catch (_e) { /* ignore */ }
      rt.setStatus('error', `更新失败${rolledBack ? '已回滚' : '（回滚失败，请人工检查 backups）'}: ${e.message}`);
      this.manager.emit('update-alert', { id, message: e.message, rolledBack });
      return { id, ok: false, error: e.message, rolledBack };
    } finally {
      this.busy.delete(id);
    }
  }

  _restore(manifest) {
    const p = this.store.getPlatform(manifest.id);
    const workDir = this.store.platformWorkDir(p);
    if (manifest.strategy === 'replace-binary' && manifest.binaryPath) {
      const files = fs.readdirSync(manifest.backupDir);
      if (files.length) fs.copyFileSync(path.join(manifest.backupDir, files[0]), manifest.binaryPath);
    } else if (fs.existsSync(manifest.backupDir)) {
      this._copyTree(manifest.backupDir, workDir);
    }
  }

  _copyTree(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      if (fs.statSync(s).isDirectory()) this._copyTree(s, d);
      else fs.copyFileSync(s, d);
    }
  }

  /** replace-binary：仅替换主程序文件（§7.2），不动 config/auths/data */
  async _replaceBinary(p, dlPath, backupDir) {
    const workDir = this.store.platformWorkDir(p);
    const rel = (p.run && p.run.binary) || '';
    if (!rel) throw new Error('replace-binary 需要 run.binary');
    const target = /[/\\]/.test(rel) ? path.join(workDir, rel) : this._findExecutable(workDir, rel);
    if (!target) throw new Error(`未找到待替换的二进制: ${rel}（cwd=${workDir}）`);
    fs.copyFileSync(target, path.join(backupDir, path.basename(target))); // 备份
    fs.copyFileSync(dlPath, target);                                       // 覆盖（数据文件零接触）
    try { fs.unlinkSync(dlPath); } catch (_e) { /* ignore */ }
    return { binaryPath: target };
  }

  _findExecutable(workDir, fileName) {
    const direct = path.join(workDir, fileName);
    if (fs.existsSync(direct)) return direct;
    // 在一级/二级子目录里找（如 codearts 的 bin/）
    for (const name of fs.readdirSync(workDir)) {
      const sub = path.join(workDir, name);
      try {
        if (fs.statSync(sub).isDirectory()) {
          const cand = path.join(sub, fileName);
          if (fs.existsSync(cand)) return cand;
        }
      } catch (_e) { /* ignore */ }
    }
    return null;
  }

  /** replace-dir：zip 解包 → 保护 preserveGlobs → 覆盖（§7.3） */
  async _replaceDir(p, dlPath, updDir, backupDir) {
    const workDir = this.store.platformWorkDir(p);
    const preserve = (p.updater && p.updater.preserveGlobs) || [];
    const extractDir = path.join(updDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    if (/\.zip$/i.test(dlPath)) {
      await this._unzip(dlPath, extractDir);
    } else {
      // 单 exe 的 replace-dir：直接当目录内容
      fs.copyFileSync(dlPath, path.join(extractDir, path.basename(dlPath)));
    }
    // zip 常有一层根目录，剥掉
    const src = this._stripSingleRoot(extractDir);

    // 备份「可执行部分」（排除 preserveGlobs）
    this._backupExecutablePart(src, workDir, backupDir, preserve);
    // 覆盖：新文件全量拷入，但 preserveGlobs 命中的旧数据文件不覆盖
    this._mergeTree(src, workDir, preserve);
    try { fs.rmSync(dlPath, { force: true }); } catch (_e) { /* ignore */ }
    return { binaryPath: '' };
  }

  _stripSingleRoot(dir) {
    const entries = fs.readdirSync(dir);
    if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory()) {
      return path.join(dir, entries[0]);
    }
    return dir;
  }

  _unzip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      // Windows 自带 tar 支持 zip；PowerShell Expand-Archive 兜底
      execFile('tar.exe', ['-xf', zipPath, '-C', destDir],
        { windowsHide: true, timeout: 120000 }, (err, _so, se) => {
          if (!err) return resolve();
          execFile('powershell.exe', ['-NoProfile', '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
            { windowsHide: true, timeout: 180000 }, (err2, _so2, se2) => {
              if (err2) return reject(new Error(`解压失败: ${se || se2 || err2.message}`));
              resolve();
            });
        });
    });
  }

  _backupExecutablePart(src, workDir, backupDir, preserve) {
    const walk = (dir, relBase) => {
      for (const name of fs.readdirSync(dir)) {
        const s = path.join(dir, name);
        const rel = relBase ? `${relBase}/${name}` : name;
        if (preserve.some((g) => simpleGlobMatch(g, rel))) continue;
        const st = fs.statSync(s);
        if (st.isDirectory()) walk(s, rel);
        else {
          const target = path.join(workDir, ...rel.split('/'));
          if (fs.existsSync(target)) {
            const dest = path.join(backupDir, ...rel.split('/'));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(target, dest);
          }
        }
      }
    };
    walk(src, '');
  }

  _mergeTree(src, dest, preserve) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const rel = name;
      if (preserve.some((g) => simpleGlobMatch(g, rel)) && fs.existsSync(d)) continue;
      if (fs.statSync(s).isDirectory()) this._mergeTree(s, d, preserve);
      else fs.copyFileSync(s, d);
    }
  }

  async _waitHealthy(rt, sec) {
    const h = rt.cfg.health || {};
    const deadline = Date.now() + sec * 1000;
    while (Date.now() < deadline) {
      if (!rt.proc) return false;
      const url = h.url || `http://127.0.0.1:${rt.cfg.port}/`;
      const ok = await new Promise((resolve) => {
        const mod = url.startsWith('https:') ? https : http;
        const req = mod.get(url, { timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
      });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async _download(url, destPart) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, {
        headers: { 'User-Agent': 'wanneng2api-shell' },
        timeout: 300000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._download(res.headers.location, destPart).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载失败 HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(destPart);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPart)));
        out.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
      req.on('error', reject);
    });
  }

  _sha256File(file) {
    return new Promise((resolve, reject) => {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  _pruneBackups(id, keep) {
    const dir = path.join(this.updatesDir(id), 'backups');
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir).map((n) => ({ n, t: Number(n) || 0 }))
      .filter((e) => e.t > 0).sort((a, b) => b.t - a.t);
    for (const e of entries.slice(keep)) {
      try { fs.rmSync(path.join(dir, e.n), { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  }

  /** 全平台版本汇总（更新中心页） */
  async summary() {
    const out = [];
    for (const p of this.store.platforms.platforms) {
      const rt = this.manager.getRuntime(p.id);
      const base = {
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        status: rt ? rt.status : 'unknown',
        current: this.currentVersion(p),
        hasUpdater: !!(p.updater && p.updater.repo),
      };
      if (!base.hasUpdater || this.busy.has(p.id)) { out.push(base); continue; }
      try {
        const c = await this.check(p.id);
        out.push({ ...base, latest: c.latest, hasUpdate: c.hasUpdate, assetName: c.assetName });
      } catch (e) {
        out.push({ ...base, checkError: e.message });
      }
    }
    return out;
  }
}

module.exports = { PlatformUpdater, isNewerVersion, versionFromAsset };
