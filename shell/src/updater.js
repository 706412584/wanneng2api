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
const { simpleGlobMatch, findMagpieBinary } = require('./platform-manager');
const proxy = require('./proxy');

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
    this.installStates = new Map();
    this.installTasks = new Map();
  }

  updatesDir(id) {
    return path.join(this.dataDir, 'updates', id);
  }

  // ── §7.1 检查 ──
  async check(id, { forInstall = false } = {}) {
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
    const hasUpdate = !!asset && (forInstall || isNewerVersion(latestVersion, current));
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
      sha256: asset && asset.digest && asset.digest.startsWith('sha256:')
        ? asset.digest.slice(7).toLowerCase() : (asset ? this._assetDigest(latest, asset.name) : null),
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
      // 走代理与否由「平台更新」这一勾选项决定（GitHub API 直连国内常超时）
      const req = https.get(url, proxy.withAgent('platformUpdate', {
        headers: {
          'User-Agent': 'wanneng2api-shell',
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15000,
      }), (res) => {
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

  installStatus(id) {
    return this.installStates.get(id) || { id, status: this.manager.isInstalled(id) ? 'installed' : 'not-installed' };
  }

  install(id) {
    if (!['workbuddy', 'codearts', 'loomy', 'lingxi'].includes(id)) throw new Error('该平台不支持一键安装');
    if (this.manager.isInstalled(id) && !['error', 'installed-without-provider'].includes(this.installStatus(id).status)) {
      return Promise.resolve({ started: false, installed: true, ...this.installStatus(id) });
    }
    if (this.installTasks.has(id)) return Promise.resolve({ started: false, ...this.installStatus(id) });
    const task = this._install(id).catch((e) => {
      this._installState(id, { status: 'error', message: e.message });
    }).finally(() => this.installTasks.delete(id));
    this.installTasks.set(id, task);
    return Promise.resolve({ started: true, ...this.installStatus(id) });
  }

  _installState(id, patch) {
    const next = { ...this.installStatus(id), ...patch, updatedAt: Date.now() };
    this.installStates.set(id, next);
    return next;
  }

  async _install(id) {
    const p = this.store.getPlatform(id);
    const workDir = this.store.platformWorkDir(p);
    const stage = path.join(this.dataDir, 'updates', id, 'install');
    const extractDir = path.join(stage, 'extracted');
    if (this.manager.isInstalled(id)) {
      this._installState(id, { status: 'starting', message: '程序已在目录中，正在恢复启动与注册…' });
      try {
        const rt = this.manager.getRuntime(id);
        if (!rt.proc) await this.manager.start(id, { waitForHealth: false });
        const listening = rt.adopted || await this.manager.waitForListening(id);
        if (!listening) throw new Error('程序已安装，但服务未能监听端口，请查看平台日志');
        const registration = await this.registerProvider(id);
        this._installState(id, {
          status: registration.ok ? 'installed' : 'installed-without-provider',
          message: registration.ok ? '安装完成，请在管理中添加账号' : `安装完成；${registration.message}`,
          registration,
        });
      } catch (e) {
        this._installState(id, { status: 'error', message: e.message });
      }
      return;
    }
    const protectedFiles = ['config.json', 'accounts.json', 'auths', 'data', 'config.yaml'];
    if (fs.existsSync(workDir) && protectedFiles.some((name) => fs.existsSync(path.join(workDir, name)))) {
      this._installState(id, {
        status: 'needs-import',
        message: '该目录已有配置或账号数据，但未找到主程序。为保护数据，未写入任何文件；请换空目录安装，或手工恢复主程序后重试。',
      });
      return;
    }
    this._installState(id, { status: 'checking', message: '正在获取发布版本…', received: 0, total: 0 });
    try {
      const info = await this.check(id, { forInstall: true });
      if (!info.checked || !info.assetUrl) throw new Error(info.reason || '当前系统没有匹配的发布包');
      fs.mkdirSync(stage, { recursive: true });
      const dlPath = path.join(stage, `${info.assetName}.part`);
      this._installState(id, { status: 'downloading', message: `正在下载 ${info.assetName}`, version: info.latest });
      await this._download(info.assetUrl, dlPath, 0, ({ received, total }) => {
        this._installState(id, { received, total: total || info.assetSize || 0 });
      });
      if (info.sha256) {
        const actual = await this._sha256File(dlPath);
        if (actual !== info.sha256) throw new Error('发布包 SHA-256 校验失败');
      }
      this._installState(id, { status: 'extracting', message: '正在解压并准备默认配置…' });
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      await this._extract(dlPath, extractDir, info.assetName);
      if (this.manager.isInstalled(id)) {
        this._installState(id, { status: 'installed', message: '检测到已有安装，已保留原目录与配置', version: info.latest });
        return;
      }
      const src = this._stripSingleRoot(extractDir);
      fs.mkdirSync(workDir, { recursive: true });
      this._mergeTree(src, workDir, (p.updater && p.updater.preserveGlobs) || []);
      this._writeInitialConfig(id, workDir, p.port);
      this.store.updatePlatform(id, { updater: { ...(p.updater || {}), currentVersion: info.latest } });
      this._installState(id, { status: 'starting', message: '正在启动并验证本机服务…', version: info.latest });
      const rt = this.manager.getRuntime(id);
      await this.manager.start(id, { waitForHealth: false });
      if (rt.adopted) {
        this._installState(id, { status: 'installed', message: '检测到已运行的网关，已复用现有配置' });
        return;
      }
      const listening = await this.manager.waitForListening(id);
      if (!listening) throw new Error('程序已安装，但服务未能监听端口，请查看平台日志');
      this._installState(id, { status: 'registering', message: '正在注册到 magpie…', version: info.latest });
      const registration = await this.registerProvider(id);
      this._installState(id, {
        status: registration.ok ? 'installed' : 'installed-without-provider',
        message: registration.ok ? '安装完成，请在管理中添加账号' : `安装完成；${registration.message}`,
        version: info.latest, registration,
      });
    } catch (e) {
      this._installState(id, { status: 'error', message: e.message });
    }
  }

  _writeInitialConfig(id, workDir, port) {
    const file = path.join(workDir, 'config.json');
    if (fs.existsSync(file)) return;
    if (fs.existsSync(path.join(workDir, 'accounts.json'))
      || fs.existsSync(path.join(workDir, 'auths')) || fs.existsSync(path.join(workDir, 'data'))) {
      throw new Error('已有账号数据但缺少配置，未生成新配置；请先备份并导入原配置');
    }
    const config = {
      listen: `127.0.0.1:${port}`,
      api_key: require('crypto').randomBytes(32).toString('hex'),
      auth_dir: './auths',
      state_file: './data/state.json',
    };
    if (id === 'codearts') config.admin_key = require('crypto').randomBytes(32).toString('hex');
    if (id === 'loomy') {
      config.host = '127.0.0.1';
      config.port = port;
      config.api_keys = [config.api_key];
      delete config.api_key;
      delete config.listen;
      delete config.auth_dir;
      delete config.state_file;
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    if (id === 'loomy') {
      const accounts = path.join(workDir, 'accounts.json');
      if (!fs.existsSync(accounts)) fs.writeFileSync(accounts, '{"accounts":[]}\n', { mode: 0o600, flag: 'wx' });
    }
  }

  _gatewayConfig(workDir) {
    try { return JSON.parse(fs.readFileSync(path.join(workDir, 'config.json'), 'utf8')); } catch { return {}; }
  }

  async registerProvider(id) {
    const p = this.store.getPlatform(id);
    if (!p || !['workbuddy', 'codearts', 'loomy', 'lingxi'].includes(id)) return { ok: false, message: '该平台不支持注册为自研网关' };
    if (!this.manager.isInstalled(id)) return { ok: false, message: '网关尚未安装' };
    const magpie = require('./magpie-adapter');
    const bin = findMagpieBinary(this.dataDir);
    if (!bin) return { ok: false, message: 'magpie 尚未安装，安装内核后可重试注册' };
    const cfg = this._gatewayConfig(this.store.platformWorkDir(p));
    const firstKey = Array.isArray(cfg.api_keys) ? cfg.api_keys[0] : '';
    const key = cfg.api_key || (typeof firstKey === 'string' ? firstKey : firstKey && firstKey.key) || '';
    if (!key) return { ok: false, message: '未找到网关 API 密钥，未修改 magpie 配置' };
    const args = [`url=http://127.0.0.1:${p.port}`];
    if (id !== 'lingxi') args.push(`anthropic=http://127.0.0.1:${p.port}`);
    args.push('models=*');
    const result = await magpie.addProvider(bin, { id: `wanneng-${id}`, key, args });
    const redact = (value) => String(value || '').replace(/\b[A-Fa-f0-9]{32,}\b/g, '[已隐藏]')
      .replace(/([?&](?:k|key|token|api_key)=)[^&\s]+/gi, '$1[已隐藏]').slice(0, 300);
    return { ok: result.ok, message: result.ok ? '已注册到 magpie' : redact(result.stderr || result.stdout || 'magpie 注册失败，可重试').replaceAll(key, '[已隐藏]') };
  }

  // ── §7.2 / §7.3 应用 ──

  /**
   * 下发更新，**立即返回**，真正的下载/替换/重启在后台跑。
   *
   * 为什么必须异步：整个过程要下载几十 MB、校验、停服、备份、替换、
   * 重启并等最长 60s 健康验证，动辄几分钟。过去这里是同步 await，
   * 浏览器的 fetch 会在默认 8s 超时后 abort，用户看到的是
   * 「更新下发失败：signal is aborted without reason」——而更新其实
   * 还在后台跑着。真实进度与失败由前端轮询平台 state=updating / error
   * 与 lastError 呈现（Updates.jsx 的回滚告警条就是这么读的）。
   * 唯一会同步抛出的错误保留在参数校验阶段（未知平台/已在更新/无可用更新）。
   */
  async apply(id, checkInfo) {
    const p = this.store.getPlatform(id);
    if (!p) throw new Error(`未知平台: ${id}`);
    if (this.busy.has(id)) throw new Error('该平台正在更新中');
    const rt = this.manager.getRuntime(id);
    if (!rt) throw new Error(`未知平台: ${id}`);
    if (rt.status === 'updating') throw new Error('平台已在更新流程中');

    // 占位登记要同步做：前端下发后会立刻开始高频轮询，
    // 若在这个空档里再点一次「立即更新」，busy 还没置位就会重复下发。
    this.busy.add(id);
    this._backgroundApply(id, p, rt, checkInfo).catch((e) => {
      this.log.error(`[update:${id}] 后台更新异常: ${e.message}`);
    }).finally(() => { this.busy.delete(id); });
    return { id, started: true, message: '已开始下载并安装，可在下方观察状态' };
  }

  /**
   * 后台：先确定目标版本，再执行安装。
   *
   * 连 check 也放后台：GitHub API 单次超时 15s，本身就超过浏览器的
   * 默认 8s fetch 超时，留在同步段会再次触发同一类 abort。
   */
  async _backgroundApply(id, p, rt, checkInfo) {
    let info;
    try {
      info = checkInfo || await this.check(id);
    } catch (e) {
      rt.appendLog('manager', `[update] 检查更新失败: ${e.message}`);
      rt.setStatus(rt.proc ? 'healthy' : 'stopped', `检查更新失败：${e.message}`);
      this.manager.emit('update-alert', { id, message: e.message, rolledBack: false, harmless: true });
      return;
    }
    if (!info.checked || !info.hasUpdate || !info.assetUrl) {
      const msg = `无可用更新（current=${info.current}, latest=${info.latest}）`;
      rt.appendLog('manager', `[update] ${msg}`);
      rt.setStatus(rt.proc ? 'healthy' : 'stopped', msg);
      this.manager.emit('update-alert', { id, message: msg, rolledBack: false, harmless: true });
      return;
    }
    return this._runApply(p, rt, info);
  }

  /** 后台更新流程（原 apply 主体，不再向外抛错——失败通过状态与告警呈现） */
  async _runApply(p, rt, info) {
    const id = p.id;
    const strategy = (p.updater && p.updater.strategy) || 'replace-binary';
    const updDir = path.join(this.updatesDir(id), String(info.latest).replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(updDir, { recursive: true });
    const marker = path.join(this.updatesDir(id), '.updating');

    // 文件是否已被改动过：只有替换/安装这一步跑过，才存在「需要回滚」的
    // 状态。下载阶段就失败（GitHub 连不上是常态）时机器上什么都没变，
    // 旧代码却一律报「回滚失败，请人工检查 backups」——用户看到平台明明
    // 跑得好好的却被标成错误。
    let replaced = false;
    let platformStopped = false;
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

      // 3. stop 平台。必须带 forUpdate：更新已把自己标成 updating，
      // 默认守卫会以「平台更新中，禁止停止」拒绝，导致永远装不上。
      if (rt.proc) { await this.manager.stop(id, { forUpdate: true }); platformStopped = true; }

      // 4. 备份
      const backupDir = path.join(this.updatesDir(id), 'backups', String(Date.now()));
      fs.mkdirSync(backupDir, { recursive: true });
      const manifest = { id, version: info.latest, strategy, backupDir };

      // 替换前就把 manifest 落盘，并把 replaced 提前置位：替换过程本身
      // 可能写到一半失败（旧文件已被截断），这种也算「已改动」必须回滚。
      // 只有「还没走到替换」的失败（下载/校验）才是无需回滚的。
      fs.writeFileSync(marker, JSON.stringify(manifest));
      replaced = true;
      let installed;
      if (strategy === 'replace-binary') {
        installed = await this._replaceBinary(p, dlPath, backupDir);
      } else {
        installed = await this._replaceDir(p, dlPath, updDir, backupDir);
      }
      manifest.binaryPath = installed.binaryPath || '';
      fs.writeFileSync(marker, JSON.stringify(manifest));

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
          // forUpdate：平台原本没在运行时状态仍是 updating，默认守卫会拒绝
          await this.manager.start(id, { forUpdate: true });
          platformStopped = false;
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
      // 7. 失败：只有真的改动过文件才需要回滚
      const upstream = /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|certificate/i.test(e.message);
      let rolledBack = false;
      if (!replaced) {
        // 没动过文件：无需回滚。平台若被停过（不太可能，下载失败在停服之前）
        // 就恢复运行，否则保持原状。
        rt.appendLog('manager', `[update] 失败于安装前（未改动任何文件）: ${e.message}`);
        try {
          // forUpdate：这条路径同样可能还处于 updating 状态
          if (platformStopped) { await this.manager.start(id, { forUpdate: true }); platformStopped = false; }
        } catch (_e) { /* 保持现状 */ }
        const hint = upstream ? '（无法连接 GitHub，请检查网络或代理）' : '';
        // 不能标 error：平台本身好好的、旧版本照常跑，标 error 会让平台卡
        // 显示「错误」并禁用启停。状态按实际进程给，原因写进 lastError，
        // 平台卡会把它显示成一行说明，更新中心据此给出中性提示。
        rt.setStatus(rt.proc ? 'healthy' : 'stopped',
          `更新下载失败${hint}：${e.message}。原有版本未受影响，仍可正常使用。`);
        this.manager.emit('update-alert', { id, message: e.message, rolledBack: false, harmless: true });
        return { id, ok: false, error: e.message, rolledBack: false, untouched: true };
      }
      rt.appendLog('manager', `[update] 失败: ${e.message}，尝试回滚`);
      try {
        const raw = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
        const manifest = raw ? JSON.parse(raw) : null;
        if (manifest && manifest.backupDir && fs.existsSync(manifest.backupDir)) {
          // 回滚同样处于 updating 状态，也要放行，否则回滚停不掉进程
          if (rt.proc) { await this.manager.stop(id, { forUpdate: true }).catch(() => {}); }
          this._restore(manifest);
          // 同样不能对禁用平台调 start()：那会抛「平台已禁用」，
          // 让一次成功回滚被误报成「回滚失败，请人工检查 backups」。
          if (rt.cfg && rt.cfg.enabled === false) {
            rt.setStatus('stopped');
          } else {
            await this.manager.start(id, { forUpdate: true });
          }
          rolledBack = true;
        }
      } catch (re) {
        rt.appendLog('manager', `[update] 回滚也失败: ${re.message}`);
      }
      try { fs.unlinkSync(marker); } catch (_e) { /* ignore */ }
      if (rolledBack) {
        // 已回滚：平台已恢复到旧版本且能跑，不该再标成 error 让人以为坏了
        rt.setStatus('healthy', `更新失败已回滚: ${e.message}`);
        rt.appendLog('manager', `[update] 已回滚到旧版本，平台恢复正常`);
        this.manager.emit('update-alert', { id, message: e.message, rolledBack: true });
      } else {
        rt.setStatus('error', `更新失败（回滚失败，请人工检查 backups）: ${e.message}`);
        this.manager.emit('update-alert', { id, message: e.message, rolledBack: false });
      }
      return { id, ok: false, error: e.message, rolledBack };
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

  _extract(archivePath, destDir, assetName) {
    if (/\.zip$/i.test(assetName)) return this._unzip(archivePath, destDir);
    if (!/\.tar\.gz$/i.test(assetName)) return Promise.reject(new Error('不支持的发布包格式'));
    return new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 180000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) return reject(new Error(`解压失败: ${stderr || err.message}`));
        this._makeExecutables(destDir);
        resolve();
      });
    });
  }

  _makeExecutables(dir) {
    if (process.platform === 'win32') return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) this._makeExecutables(file);
      else if (!/\.(?:json|md|txt)$/i.test(name)) fs.chmodSync(file, 0o755);
    }
  }

  _unzip(zipPath, destDir) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      for (const entry of zip.getEntries()) {
        const name = entry.entryName;
        if (entry.header.size > 512 * 1024 * 1024) throw new Error('发布包单个文件超过 512 MB，已停止解压');
        if ((entry.attr >>> 16 & 0o170000) === 0o120000) throw new Error('发布包不允许包含符号链接');
        if (!name || name.includes('\0') || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
          throw new Error(`发布包含非法路径: ${name}`);
        }
        const target = path.resolve(destDir, name);
        const relative = path.relative(path.resolve(destDir), target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`发布包路径越界: ${name}`);
        }
      }
      zip.extractAllTo(destDir, true);
      this._makeExecutables(destDir);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(new Error(`解压失败: ${e.message}`));
    }
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

  async _download(url, destPart, hop = 0, onProgress = null) {
    // GitHub 的资源地址会 302 到 objects.githubusercontent.com，正常一跳；
    // 给个上限避免被错误配置的代理/异常跳转拖成无限递归。
    if (hop > 5) throw new Error('下载重定向次数过多');
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(url, proxy.withAgent('platformUpdate', {
        headers: { 'User-Agent': 'wanneng2api-shell' },
        timeout: 300000,
      }), (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          this._download(new URL(res.headers.location, url).href, destPart, hop + 1, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载失败 HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(destPart);
        let received = 0;
        const total = Number(res.headers['content-length']) || 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress({ received, total });
        });
        // 响应流中途出错（连接被打断）必须落到 reject：只监听 out 的 error
        // 不够，res 的 error 没有 handler 会变成未捕获异常，把整个壳带崩。
        const fail = (e) => { out.destroy(); reject(e); };
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('下载连接被中断')));
        out.on('error', fail);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPart)));
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
