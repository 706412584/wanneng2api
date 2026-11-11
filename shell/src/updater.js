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

/**
 * 版本号切成数字段（任意段数）。
 *
 * 不能固定三段：CodeArts 用 vYY.MM.DD.N（如 26.11.05.1 → 26.11.05.2），
 * 只比前三位会把补丁版判成同一版本，永远推不到新构建。
 * CodeArts 自己的 tag 就是这个形状，见其 docs/releases/。
 */
function semverParts(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/\d+(?:\.\d+)*/);
  return m ? m[0].split('.').map(Number) : null;
}

function isNewerVersion(latest, current) {
  const a = semverParts(latest);
  const b = semverParts(current);
  if (!a) return false;
  if (!b) return true; // 当前版本未知 → 有 release 就提示
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    // 缺位按 0 处理：1.2 与 1.2.0 相等，1.2 与 1.2.1 后者更新
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 从 asset 名里提取版本号（如 wb2api-v1.2.19-windows-amd64.zip → 1.2.19）。
 *
 * 只取「点分数字段」：旧正则的 `(?:[-.][0-9A-Za-z]+)*` 会把平台后缀一起吃掉，
 * 得到 "1.2.19-windows-amd64.zip" 这种假版本号并直接显示到界面上。
 * 段数不固定（CodeArts 是四段），截到遇到非数字为止。
 */
function versionFromAsset(name) {
  // 必须有前缀边界：`v?` 直接跟在字符流里会把 wb2api 的 "v2" 认成版本，
// 于是 wb2api-v1.2.19 会解析成 "2"。用 (^|[^0-9A-Za-z]) 限制起点。
  const m = String(name).match(/(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+)*)/);
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
    let latest;
    try {
      latest = await this._fetchLatestRelease(u.repo, this.store.manager.update && this.store.manager.update.githubToken);
    } catch (e) {
      // 「仓库还没发过 Release」是仓库侧的正常状态，不是检查失败：
      // 让它走 checked:false 的同一路径，避免管理 API 把它变成 400
      // （浏览器控制台会因此报一排红色错误，用户会误以为网络出了问题）。
      if (/仓库无 release/.test(e.message)) {
        return {
          id, checked: false, noRelease: true, current: this.currentVersion(p),
          reason: `仓库 ${u.repo} 暂无 Release`,
        };
      }
      throw e;
    }
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
    // 有 Release 但没有任何资产匹配 assetPattern（例如仓库只发 APK，
    // 而这里要 windows zip）：这不是「已是最新」，用户点下去也装不了。
    // 必须单独标记，否则界面会显示绿色的「最新」，把「装不了」说成「不用装」。
    const noAsset = !asset;
    return {
      id,
      checked: true,
      current,
      latest: latestVersion || latest.tag_name,
      tagName: latest.tag_name,
      hasUpdate,
      noAsset,
      assetPattern: u.assetPattern || '',
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
      // 5. 重启 + 健康验证。
      // 已禁用的平台不能在更新后启动（start() 会拒绝 enabled=false），
      // 但那不是更新失败：文件已经装好了，只是用户没打算让它跑。
      // 过去这里会把「启动被拒」当成失败 → 回滚 → 界面永远显示更新失败，
      // 用户看到的就是「sub2api 更新永远失败」。
      const disabled = rt.cfg && rt.cfg.enabled === false;
      if (disabled) {
        rt.appendLog('manager', `[update] 已安装 ${info.latest}，但平台处于禁用状态，跳过启动验证`);
        // 必须把状态从 updating 挪走：否则界面会永远停在「更新中」，
        // 而且 start/stop 都会被「平台更新中，禁止…」挡住。
        rt.setStatus('stopped');
      } else {
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
      }

      // 6. 成功：登记版本，清理旧备份
      this.store.updatePlatform(id, { updater: { ...(p.updater || {}), currentVersion: info.latest } });
      if (rt.version !== undefined) rt.version = info.latest;
      this._pruneBackups(id, Number(this.store.manager.update && this.store.manager.update.keepBackups) || 3);
      try { fs.unlinkSync(marker); } catch (_e) { /* ignore */ }
      // 禁用平台保持 stopped：不能谎报 healthy，否则下一次点「启动」会因状态自相矛盾而困惑
      if (!disabled) rt.setStatus('healthy');
      rt.appendLog('manager', `[update] 更新成功 → ${info.latest}${disabled ? '（平台仍为禁用，启用后生效）' : ''}`);
      return {
        id, ok: true, version: info.latest, rolledBack: false, disabled,
        message: disabled ? `已更新到 ${info.latest}；平台处于禁用状态，启用后生效` : undefined,
      };
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
          // 同样不能对禁用平台调 start()：那会抛「平台已禁用」，
          // 让一次成功回滚被误报成「回滚失败，请人工检查 backups」。
          if (rt.cfg && rt.cfg.enabled === false) {
            rt.setStatus('stopped');
          } else {
            await this.manager.start(id);
          }
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
    // POSIX 下覆盖会把执行位一起抹掉（新文件是 0644），更新后启动 EACCES。
    if (process.platform !== 'win32') {
      try { fs.chmodSync(target, 0o755); } catch { /* 启动时会报 EACCES 并提示 chmod */ }
    }
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

    // 下载路径是 "<资产名>.part"（防半包），所以不能拿它和 /\.zip$/ 比：
  // 那个判断永远为假，zip 会被当成「单 exe」整包拷进工作目录，
  // 于是 sub2api/WorkBuddy/CodeArts 这类 replace-dir 平台每次更新都必然失败。
  // 判据要用「原始资产名」——即去掉末尾 .part 后的名字。
  const assetName = path.basename(dlPath).replace(/\.part$/i, '');
  if (/\.zip$/i.test(assetName)) {
      await this._unzip(dlPath, extractDir);
    } else {
      // 单 exe 的 replace-dir：直接当目录内容
      fs.copyFileSync(dlPath, path.join(extractDir, assetName));
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
      // 无论哪个平台，都先把 .part 还原成 .zip：
      // cat 只看扩展名 + 魔数，.part 后缀的 zip 会被判「不是 tar」。
      const dir = path.dirname(zipPath);
      const base = path.basename(zipPath).replace(/\.part$/i, '');
      const zipDepot = path.join(dir, base.endsWith('.zip') ? base : base + '.zip');
      try {
        if (zipDepot !== zipPath && !fs.existsSync(zipDepot)) fs.copyFileSync(zipPath, zipDepot);
      } catch (_e) { /* 让下面的解压报出真实原因 */ }

      if (process.platform === 'win32') {
        // Windows 自带 tar 是 libarchive：能解 zip，但绝对路径 'C:\...' 会被
        // 当成「远端主机 C」→ 必须加 --force-local。
        // PowerShell Expand-Archive 作兜底。
        execFile('tar.exe', ['--force-local', '-xf', zipDepot, '-C', destDir],
          { windowsHide: true, timeout: 120000 }, (err, _so, se) => {
            if (!err) return resolve();
            execFile('powershell.exe', ['-NoProfile', '-Command',
              `Expand-Archive -LiteralPath '${zipDepot}' -DestinationPath '${destDir}' -Force`],
              { windowsHide: true, timeout: 180000 }, (err2, _so2, se2) => {
                if (err2) return reject(new Error(`解压失败: ${se || se2 || err2.message}`));
                resolve();
              });
          });
        return;
      }

      // POSIX：优先 unzip（存在最广），没有就退回 bsdtar/GNU tar。
      // 两者都没有才报错，并把可执行的补救办法写进消息里。
      execFile('unzip', ['-o', '-q', zipDepot, '-d', destDir],
        { timeout: 180000 }, (err, _so, se) => {
          if (!err) return resolve();
          execFile('tar', ['-xf', zipDepot, '-C', destDir],
            { timeout: 180000 }, (err2, _so2, se2) => {
              if (err2) {
                return reject(new Error(
                  `解压失败：需要 unzip 或支持 zip 的 tar（${se || se2 || err2.message}）`));
              }
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
      else {
        fs.copyFileSync(s, d);
        // POSIX 下 copyFileSync 不保留权限位：zip 解出来的可执行文件
        // 会变成 0644，更新「成功」但下次启动 EACCES。这里把源文件
        // 的执行位带过去（非可执行文件不受影响）。
        if (process.platform !== 'win32') {
          try {
            if (fs.statSync(s).mode & 0o111) fs.chmodSync(d, 0o755);
          } catch { /* 权限设置失败不阻断更新，启动时会报 EACCES 并提示 chmod */ }
        }
      }
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
        // 仓库地址给前端拼「查看发布页」链接（没有更新源时为空）
        repo: (p.updater && p.updater.repo) || '',
      };
      if (!base.hasUpdater || this.busy.has(p.id)) { out.push(base); continue; }
      try {
        const c = await this.check(p.id);
        out.push({
          ...base, latest: c.latest, hasUpdate: c.hasUpdate, assetName: c.assetName,
          // 仓库还没发 Release（check 已归一到 checked:false，不再抛异常）
          ...(c.noRelease ? { noRelease: true, checkError: c.reason } : {}),
          // 有 Release 但资产不匹配：界面要显示「无匹配资产」而不是「最新」
          ...(c.noAsset ? { noAsset: true, assetPattern: c.assetPattern, allAssets: c.allAssets } : {}),
        });
      } catch (e) {
        out.push({ ...base, checkError: e.message });
      }
    }
    return out;
  }
}

module.exports = { PlatformUpdater, isNewerVersion, versionFromAsset };
