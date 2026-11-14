'use strict';
/**
 * config.js — manager.json / platforms.json 读写 + 默认值（纯 Node 模块）
 *
 * 数据目录：%AppData%/wanneng2api（可用 WANENG_DATA_DIR 覆盖，供测试）
 * - manager.json  : 壳子全局配置（§4.1）
 * - platforms.json: 平台注册表（§4.2），首次不存在时生成默认值
 */

const fs = require('fs');
const path = require('path');

function appDataDir() {
  if (process.env.WANENG_DATA_DIR) return process.env.WANENG_DATA_DIR;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'wanneng2api');
  // 非 Windows 回落（开发/CI）
  return path.join(process.env.HOME || process.env.USERPROFILE || '.', '.wanneng2api');
}

function defaultManagerConfig() {
  return {
    general: {
      language: 'zh-CN',
      theme: 'auto',
      closeAction: 'tray',            // tray | quit
      autoStart: false,               // 开机自启（app.setLoginItemSettings）
      startMinimized: false,
      autoStartPlatforms: ['workbuddy', 'codearts', 'loomy', 'lingxi', 'magpie', 'magpie-web'],
      autoStartDelaySec: 0,
    },
    manager: {
      listen: '127.0.0.1:17800',
      logLevel: 'info',
    },
    update: {
      checkOnLaunch: true,
      channel: 'stable',
      githubToken: '',
      keepBackups: 3,
    },
    // 代理：一律由用户显式开启，不做自动探测。Node 的 http/https 默认不读
    // 代理环境变量；而「该不该走代理」只有用户知道（本机既有能达 GitHub 的
    // 代理，也有只对国内通的），自动套上反而可能把本来通的流量带偏。
    // scopes 决定哪些流量走代理，逐项可关。
    proxy: {
      enabled: false,
      url: '',
      scopes: {
        selfUpdate: false,          // 壳自更新（electron-updater）
        platformUpdate: false,      // 平台更新（GitHub 检查 + 资产下载）
        pluginRegistry: false,      // magpie 插件市场目录
        magpieKernel: false,        // magpie 内核检测与下载
        magpieSubscription: false,  // 写入 magpie proxy：订阅流量
        magpiePlugin: false,        // 写入 magpie pluginProxy：插件流量
      },
    },
    sub2api: {
      pgPort: 5433,
      redisPort: 6380,
      dbPassword: '',                 // 首次启用 sub2api 时随机生成
      dataDir: '',
    },
  };
}

/** 展开 "x/%APPDATA%/y" 中的环境变量（正斜杠统一） */
function expandPath(p) {
  if (!p) return p;
  let out = String(p).replace(/\\/g, '/');
  out = out.replace(/%APPDATA%/gi, process.env.APPDATA || '');
  out = out.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  return out;
}

/**
 * 五个默认平台（§4.2 + 已核实事实）：
 * - workbuddy : server.exe（不是 wb2api.exe），cwd=D:/软件/workbuddy2api（导入），7863 /healthz /__admin/
 * - codearts  : codearts2api-panel.exe 与原配置/账号库都在 bin/，cwd=D:/app/codearts2api-panel/bin（导入），7866 /healthz
 * - loomy     : python -m loomy2api serve，cwd=D:/app/loomy2api（导入），17990 /health /panel
 * - sub2api   : server.exe + 编排 PG:5433 / Redis:6380，/health（routes/common.go:12 已确认），默认关闭
 * - hub       : ../hub/hub.exe（另一代理交付），17810，/health
 */
/**
 * 默认可执行文件名。
 *
 * 各网关在 Windows 上带 .exe，POSIX 上不带。默认配置会落盘成 platforms.json，
 * 所以这里必须按平台生成——否则 Linux 首次运行会写出 wb2api.exe 这种在
 * 该平台根本不存在的文件名，启动时直接 ENOENT。
 * 能力：strip 掉 .exe 即可，各家的基名一致。
 */
const EXE = process.platform === 'win32' ? '.exe' : '';

function defaultPlatforms({ forInstall = false, dataDir = appDataDir() } = {}) {
  const managedDir = (id) => forInstall ? path.join(dataDir, 'platforms', id) : null;
  return {
    version: 1,
    platforms: [
      {
        id: 'workbuddy',
        name: 'WorkBuddy2API',
        type: 'go-binary',
        enabled: true,
        mode: forInstall ? 'managed' : 'import',
        workDir: managedDir('workbuddy') || 'D:/软件/workbuddy2api',
        run: {
          // 必须是 wb2api.exe：它才是与 start.cmd 一致、含最新指纹/会话头修复的
          // 构建。server.exe 是 2026-09-27 的旧产物，缺 X-Conversation-Message-ID /
          // x-codebuddy-request / X-Agent-Intent，会被上游按渠道校验拒绝（11128）。
          binary: `wb2api${EXE}`,
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 7863,
        // 收养时用于确认端口上确实是它（健康响应里应出现该标记）
        adoptHints: ['workbuddy2api'],
        health: {
          url: 'http://127.0.0.1:7863/healthz',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        // 面板挂在 "/" 兜底路由上（源码 handler.go:279 `H("/", cfg.Web)`）；
        // /__admin/ 只注册了 handler，实测返回 404。
        adminPanel: 'http://127.0.0.1:7863/',
        updater: {
          repo: '706412584/workbuddy2api',
          assetPattern: process.platform === 'win32'
            ? '^wb2api-v[0-9.]+-windows-amd64\\.zip$'
            : `^wb2api-v[0-9.]+-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}\\.tar\\.gz$`,
          strategy: 'replace-dir',
          preserveGlobs: ['config.json', 'auths/**', 'data/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        id: 'codearts',
        name: 'CodeArts2API Panel',
        type: 'go-binary',
        enabled: true,
        mode: forInstall ? 'managed' : 'import',
        workDir: managedDir('codearts') || 'D:/app/codearts2api-panel/bin',
        run: {
          binary: `codearts2api-panel${EXE}`,
          args: ['--config', 'config.json'],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 7866,
        adoptHints: ['codearts2api'],
        health: {
          url: 'http://127.0.0.1:7866/healthz',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:7866/',
        updater: {
          repo: '706412584/codearts2api-panel',
          assetPattern: process.platform === 'win32'
            ? '^codearts2api-panel_v[0-9.]+_windows_amd64\\.zip$'
            : `^codearts2api-panel_v[0-9.]+_linux_${process.arch === 'arm64' ? 'arm64' : 'amd64'}\\.tar\\.gz$`,
          strategy: 'replace-dir',
          preserveGlobs: ['config.json', 'auths/**', 'data/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        id: 'loomy',
        name: 'Loomy2API',
        type: 'python-module',
        enabled: true,
        mode: forInstall ? 'managed' : 'import',
        workDir: managedDir('loomy') || 'D:/app/loomy2api',
        run: {
          pythonPath: 'bundled',       // bundled=壳子捆绑 python-embed，找不到回落系统 python
          module: 'loomy2api',
          args: ['serve'],
          env: { NO_PROXY: '*', PYTHONIOENCODING: 'utf-8' },
        },
        port: 17990,
        adoptHints: ['loomy2api'],
        health: {
          url: 'http://127.0.0.1:17990/health',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:17990/panel',
        updater: {
          // 指向本仓库自己的分支（已公开）。上游那份没有我们需要的改动，
          // 版本号也对不上，更新会装回错的代码。
          repo: '706412584/loomy2api',
          assetPattern: '^loomy2api-v[0-9.]+\\.zip$',
          strategy: 'replace-dir',
          preserveGlobs: ['config.json', 'accounts.json', 'accounts.json.bak*', 'auths/**', 'data/**', 'logs/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        id: 'sub2api',
        name: 'Sub2API（可选）',
        // 官方上游 Wei-Shaw/sub2api（不是本地定制分支）。它本身也是一个
        // 订阅分发中转网关，与我们这套定位重叠，因此默认关闭、按需启用。
        type: 'go-binary',
        enabled: false,
        mode: 'managed',
        workDir: '%APPDATA%/wanneng2api/platforms/sub2api',
        requires: ['pg', 'redis'],
        run: {
          binary: `sub2api${EXE}`,        // 官方 release 包内的可执行文件名
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 8080,
        health: {
          url: 'http://127.0.0.1:8080/health',   // 源码 server/routes/common.go:12
          intervalSec: 20,
          timeoutSec: 5,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:8080/',
        updater: {
          repo: 'Wei-Shaw/sub2api',
          assetPattern: 'sub2api_[0-9.]+_windows_amd64\\.zip$',
          strategy: 'replace-dir',
          preserveGlobs: ['config.yaml', 'data/**', 'auths/**', '.env'],
        },
        restart: { baseBackoffSec: 5, maxBackoffSec: 600, maxRetries: 0 },
      },
      {
        id: 'lingxi',
        name: 'Lingxi2API（WPS 灵犀）',
        type: 'go-binary',
        enabled: true,
        mode: forInstall ? 'managed' : 'import',
        workDir: managedDir('lingxi') || 'D:/app/lingxi2api-panel',
        run: {
          binary: `lingxi2api${EXE}`,
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 6789,
        adoptHints: ['lingxi2api'],
        health: {
          url: 'http://127.0.0.1:6789/healthz',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:6789/panel/',
        updater: {
          // 指向本仓库自己的分支。上游至今没有发过 release，但一旦发了，
          // 壳会拉取上游代码并覆盖本地修复（上游错误伪装成正文、
          // anyOf 工具 schema 导致整轮失败）。
          repo: '706412584/lingxi2api-panel',
          assetPattern: process.platform === 'win32'
            ? '^lingxi2api-v[0-9.]+-windows-amd64\\.zip$'
            : `^lingxi2api-v[0-9.]+-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}\\.tar\\.gz$`,
          strategy: 'replace-dir',
          preserveGlobs: ['config.json', 'auths/**', 'data/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        // magpie 不是本机编译产物：它是独立安装的桌面应用，壳只做
        // 存活探测与页面跳转，不负责启动/更新（由 magpie 自己负责）。
        id: 'magpie',
        name: 'Magpie 网关',
        type: 'external',
        enabled: true,
        mode: 'external',
        workDir: '',
        run: { binary: '', args: [], env: {}, shell: false },
        managed: false,
        port: 3425,
        health: {
          url: 'http://127.0.0.1:3425/v1/models',
          intervalSec: 20,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        // 管理界面是 magpie 自己的 Web UI（另一个端口），不是网关 API 根。
        // 带 k 参数才能通过鉴权（无 key 直接 401）。
        adminPanel: 'http://127.0.0.1:17899/?k=wanneng2api-magpie-web-2026',
      },
      {
        // magpie 的网页控制台：插件管理、用量页、page 型插件都渲染在这里。
        // 由壳托管（随壳启停），provider 插件本身没有前端。
        id: 'magpie-web',
        name: 'Magpie 控制台',
        type: 'go-binary',
        enabled: true,
        mode: 'managed',
        workDir: 'D:/app/wanneng2api/tools/magpie',
        run: {
          binary: `magpie${EXE}`,
          args: ['web', '--gateway', '--no-open', '--addr', '127.0.0.1:17899'],
          env: {
            NO_PROXY: '*',
            // 固定 key：重启后链接不变，管理台可直接跳转
            MAGPIE_WEB_KEY: 'wanneng2api-magpie-web-2026',
            MAGPIE_ADDR: '127.0.0.1:3425',
          },
          shell: false,
        },
        port: 17899,
        health: {
          // 带 key 访问返回 303（跳转并下发会话 cookie），不带则 401
          url: 'http://127.0.0.1:17899/?k=wanneng2api-magpie-web-2026',
          intervalSec: 20,
          timeoutSec: 5,
          failThreshold: 3,
          okThreshold: 1,
        },
        // magpie 控制台的页面内深链接（见前端 syncURL）：
        //   ?view=providers&edit=<providerId>  直接打开某个 provider 的详情
        //   ?view=usage|routing|plugins|masking|settings&tab=<tab>
        // 我们用 `k` 参数触发鉴权并下发 cookie，再带 view/edit 落到具体页面。
        adminPanel: 'http://127.0.0.1:17899/?k=wanneng2api-magpie-web-2026&view=providers',
        restart: { baseBackoffSec: 3, maxBackoffSec: 300, maxRetries: 0 },
      },
    ],
  };
}

class ConfigStore {
  constructor(dataDir = appDataDir()) {
    this.dataDir = dataDir;
    this.managerPath = path.join(dataDir, 'manager.json');
    this.platformsPath = path.join(dataDir, 'platforms.json');
    this.manager = null;
    this.platforms = null;
    this.loadAll();
    // 新配置使用用户数据目录；已有 platforms.json 保持原目录与账号。
  }

  _ensureDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) {
      return fallback;
    }
  }

  _writeJson(file, obj) {
    this._ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  loadAll() {
    this._ensureDir();
    this.manager = { ... defaultManagerConfig(), ...this._readJson(this.managerPath, {}) };
    // 深合并一级子对象，保留新增默认键
    const defM = defaultManagerConfig();
    for (const k of Object.keys(defM)) {
      if (typeof defM[k] === 'object' && !Array.isArray(defM[k])) {
        this.manager[k] = { ...defM[k], ...(this.manager[k] || {}) };
      }
    }
    if (!fs.existsSync(this.platformsPath)) {
      this.platforms = defaultPlatforms({ forInstall: true, dataDir: this.dataDir });
      this._writeJson(this.platformsPath, this.platforms);
    } else {
      this.platforms = this._readJson(this.platformsPath, defaultPlatforms());
      if (!this.platforms || !Array.isArray(this.platforms.platforms)) {
        this.platforms = defaultPlatforms();
      } else {
        // 与内置默认值按 id 合并：老 platforms.json 也能拿到新平台
        // （如本次新增的 magpie-web）和默认项的修正（如 workbuddy 面板地址）。
        // 用户显式设置的字段优先 —— 只补缺失键，不覆盖。
        const defs = defaultPlatforms().platforms;
        const byId = new Map(this.platforms.platforms.map((p) => [p.id, p]));
        for (const def of defs) {
          const cur = byId.get(def.id);
          if (!cur) {
            byId.set(def.id, def);           // 新平台：整条补上
          } else {
            for (const k of Object.keys(def)) {
              if (!(k in cur)) cur[k] = def[k];   // 只补缺失键
            }
          }
        }
        this.platforms.platforms = [...byId.values()];
        // “只补缺失键”修不了 run.binary 这类**已存在但值错了**的字段。
        // 这里做一次有针对性的迁移：只认之前确认过的错误旧值，命中才改，
        // 用户自己改过的其它值一律不动。
        if (this._migrateKnownBadDefaults(byId)) this.savePlatforms();
      }
    }
  }

  /**
   * 修正历史上写错的默认值。只匹配「已知的错误旧值」，
   * 用户改成任何别的值都不会被这里覆盖。
   *
   * 背景（两起真实事故）：
   *  - WorkBuddy 指向 server.exe（2026-09-27 旧构建），缺客户端指纹/会话头，
   *    被上游按渠道校验拒绝（11128）。正确产物是 start.cmd 用的 wb2api.exe。
   *  - CodeArts 以根目录为 cwd 启动，读不到 bin/config.json 与 bin/auths，
   *    表现为「无账号 / 密钥不符」。原配置一直放在 bin 下。
   * @returns {boolean} 是否发生了修改
   */
  _migrateKnownBadDefaults(byId) {
    let changed = false;
    const wb = byId.get('workbuddy');
    if (wb && wb.run && wb.run.binary === 'server.exe') {
      wb.run.binary = 'wb2api.exe';
      changed = true;
    }
    const ca = byId.get('codearts');
    if (ca) {
      // 根目录 cwd + bin/ 下的可执行文件 = 读错配置的老写法
      if (ca.workDir === 'D:/app/codearts2api-panel'
        && ca.run && ca.run.binary === 'bin/codearts2api-panel.exe') {
        ca.workDir = 'D:/app/codearts2api-panel/bin';
        ca.run.binary = 'codearts2api-panel.exe';
        ca.run.args = ['--config', 'config.json'];
        changed = true;
      }
      // 已经指向 bin，但 args 里没有显式 --config：补上，避免依赖 cwd 隐式解析
      if (ca.workDir === 'D:/app/codearts2api-panel/bin' && ca.run
        && !(Array.isArray(ca.run.args) && ca.run.args.includes('--config'))) {
        ca.run.args = ['--config', 'config.json'];
        changed = true;
      }
    }
    return changed;
  }

  saveManager() {
    this._writeJson(this.managerPath, this.manager);
  }

  savePlatforms() {
    this._writeJson(this.platformsPath, this.platforms);
  }

  getPlatform(id) {
    return this.platforms.platforms.find((p) => p.id === id) || null;
  }

  updatePlatform(id, patch) {
    const p = this.getPlatform(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.savePlatforms();
    return p;
  }

  /**
 * 平台 workDir 绝对路径（展开 %APPDATA% 等）。
 *
 * 跨平台迁移的坑：path.isAbsolute 只看当前平台的规则。
 * 在 Linux 上 'D:/软件/workbuddy2api' 不是绝对路径（POSIX 只认 '/' 开头），
 * 于是被当相对路径拼到数据目录后面，变成
 *   /home/x/.config/wanneng2api/D:/软件/workbuddy2api
 * 一个根本不存在的路径，平台必然启动失败。
 *
 * 所以先识别「另一种平台的绝对路径」：Windows 盘符或 UNC。
 * 这类路径在 POSIX 上无法直接使用，但至少要原样保留，
 * 让启动时报「文件不存在: D:/软件/...」——用户一眼就知道是配置指向了
 * Windows 上的目录，而不是被拼成一个诡异的相对路径。
 */
  platformWorkDir(p) {
    const expanded = expandPath(p.workDir);
    if (!expanded) return this.dataDir;
    if (path.isAbsolute(expanded)) return expanded;
    // Windows 风格绝对路径：盘符（D: / D:\ / D:/）或 UNC（\\server\share）
    if (/^[A-Za-z]:[\\/]/.test(expanded) || /^\\\\/.test(expanded)) return expanded;
    // 相对路径相对壳子根目录（如 hub 的 ../hub/hub.exe 场景）
    return path.resolve(this.dataDir, expanded);
  }
}

module.exports = { ConfigStore, defaultManagerConfig, defaultPlatforms, appDataDir, expandPath };
