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
 * - codearts  : codearts2api-panel.exe 在 bin/ 子目录，cwd=D:/app/codearts2api-panel（导入），7866 /healthz
 * - loomy     : python -m loomy2api serve，cwd=D:/app/loomy2api（导入），17990 /health /panel
 * - sub2api   : server.exe + 编排 PG:5433 / Redis:6380，/health（routes/common.go:12 已确认），默认关闭
 * - hub       : ../hub/hub.exe（另一代理交付），17810，/health
 */
function defaultPlatforms() {
  return {
    version: 1,
    platforms: [
      {
        id: 'workbuddy',
        name: 'WorkBuddy2API',
        type: 'go-binary',
        enabled: true,
        mode: 'import',
        workDir: 'D:/软件/workbuddy2api',
        run: {
          binary: 'server.exe',
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 7863,
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
          repo: '',
          assetPattern: 'workbuddy2api.*windows.*amd64\\.exe$',
          strategy: 'replace-binary',
          preserveGlobs: ['config.json', 'auths/**', 'data/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        id: 'codearts',
        name: 'CodeArts2API Panel',
        type: 'go-binary',
        enabled: true,
        mode: 'import',
        workDir: 'D:/app/codearts2api-panel',
        run: {
          binary: 'bin/codearts2api-panel.exe',
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 7866,
        health: {
          url: 'http://127.0.0.1:7866/healthz',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:7866/',
        updater: {
          repo: '',
          assetPattern: '.*windows.*\\.exe$',
          strategy: 'replace-binary',
          preserveGlobs: ['config.json', 'auths/**', 'data/**'],
        },
        restart: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
      },
      {
        id: 'loomy',
        name: 'Loomy2API',
        type: 'python-module',
        enabled: true,
        mode: 'import',
        workDir: 'D:/app/loomy2api',
        run: {
          pythonPath: 'bundled',       // bundled=壳子捆绑 python-embed，找不到回落系统 python
          module: 'loomy2api',
          args: ['serve'],
          env: { NO_PROXY: '*', PYTHONIOENCODING: 'utf-8' },
        },
        port: 17990,
        health: {
          url: 'http://127.0.0.1:17990/health',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:17990/panel',
        updater: {
          repo: 'Patrick130306/loomy2api',
          assetPattern: '.*\\.zip$',
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
          binary: 'sub2api.exe',        // 官方 release 包内的可执行文件名
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
        mode: 'import',
        workDir: 'D:/app/lingxi2api-panel',
        run: {
          binary: 'lingxi2api.exe',
          args: [],
          env: { NO_PROXY: '*' },
          shell: false,
        },
        port: 6789,
        health: {
          url: 'http://127.0.0.1:6789/healthz',
          intervalSec: 15,
          timeoutSec: 3,
          failThreshold: 3,
          okThreshold: 1,
        },
        adminPanel: 'http://127.0.0.1:6789/panel/',
        updater: {
          repo: 'ketion/lingxi2api-panel',
          assetPattern: '.*windows.*\\.exe$',
          strategy: 'replace-binary',
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
        adminPanel: 'http://127.0.0.1:17899/',
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
          binary: 'magpie.exe',
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
      this.platforms = defaultPlatforms();
      this._writeJson(this.platformsPath, this.platforms);
    } else {
      this.platforms = this._readJson(this.platformsPath, defaultPlatforms());
      if (!this.platforms || !Array.isArray(this.platforms.platforms)) {
        this.platforms = defaultPlatforms();
      }
    }
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

  /** 平台 workDir 绝对路径（展开 %APPDATA% 等） */
  platformWorkDir(p) {
    const expanded = expandPath(p.workDir);
    if (path.isAbsolute(expanded)) return expanded;
    // 相对路径相对壳子根目录（如 hub 的 ../hub/hub.exe 场景）
    return path.resolve(this.dataDir, expanded);
  }
}

module.exports = { ConfigStore, defaultManagerConfig, defaultPlatforms, appDataDir, expandPath };
