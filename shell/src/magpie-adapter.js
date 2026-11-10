'use strict';
/**
 * magpie-adapter.js — 读取 magpie 内核状态（provider 列表、版本）
 *
 * magpie 没有全部状态的 JSON 输出（`magpie providers --json` 不生效），
 * 因此直接读它的数据文件：
 *   ~/.config/magpie/providers.json          自定义 provider（我们接入的网关）
 *   ~/.config/magpie/plugin-providers.json   插件提供的 provider（官方/社区插件）
 *   ~/.config/magpie/plugins.json            已安装插件清单
 * 版本用 `magpie --version` 探测。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const MAGPIE_RELEASES_REPO = 'yetone/magpie-releases';

/** magpie 的配置目录：Windows 下 ~/.config/magpie 优先，其次 LOCALAPPDATA/APPDATA */
function magpieConfigDir() {
  const home = os.homedir();
  const cands = [
    path.join(home, '.config', 'magpie'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'magpie') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'magpie') : null,
  ].filter(Boolean);
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'providers.json'))) return d;
  }
  return cands[0];
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 我们的网关 id 清单。这些在 magpie 里是 custom provider，
 * 但语义上属于"我们自己接入的"，UI 标记为「插件」。
 */
const OUR_IDS = ['wanneng-workbuddy', 'wanneng-codearts', 'wanneng-loomy', 'wanneng-lingxi'];
const OUR_PREFIX = 'wanneng-';

// magpie 内置订阅 provider 的显示名
const BUILTIN_NAMES = {
  claude: 'Claude（订阅）',
  codex: 'Codex / ChatGPT（订阅）',
  copilot: 'GitHub Copilot（订阅）',
  gemini: 'Gemini Code Assist（订阅）',
  antigravity: 'Antigravity（订阅）',
  grok: 'Grok / SuperGrok（订阅）',
};

function classify(id, isPlugin) {
  if (isPlugin) return 'official';           // 来自 magpie 插件（kiro/zcode/codex…）
  if (OUR_IDS.includes(id) || id.startsWith(OUR_PREFIX)) return 'plugin'; // 我们接入的
  return 'official';                          // 其余视为官方/内置
}

function listProviders() {
  const dir = magpieConfigDir();
  const custom = readJson(path.join(dir, 'providers.json'), { providers: [] });
  const pluginProviders = readJson(path.join(dir, 'plugin-providers.json'), []);
  const plugins = readJson(path.join(dir, 'plugins.json'), { plugins: [] });
  const logins = readJson(path.join(dir, 'logins.json'), []);

  const out = [];
  const seen = new Set();

  for (const p of custom.providers || []) {
    if (!p || !p.id) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      name: p.name || p.id,
      origin: classify(p.id, false),
      baseUrl: p.chat || p.anthropic || '',
      anthropic: p.anthropic || '',
      models: Array.isArray(p.models) ? p.models.length : 0,
      signedIn: !!p.key,
    });
  }

  for (const p of Array.isArray(pluginProviders) ? pluginProviders : []) {
    if (!p || !p.id) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      name: p.name || p.id,
      origin: 'official',
      baseUrl: p.api || '',
      anthropic: '',
      models: 0,
      signedIn: true,
      spec: p.spec || '',
    });
  }

  // 已装插件里可能有 provider 尚未登录，一并列出便于识别
  for (const pl of (plugins.plugins || [])) {
    const spec = pl.spec || '';
    const m = /opencode-([a-z0-9-]+)-auth/i.exec(spec);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: id,
      origin: 'official',
      baseUrl: '',
      anthropic: '',
      models: 0,
      signedIn: false,
      spec,
    });
  }

  // magpie 内置订阅（Claude / Codex / Copilot 等）：不在 providers.json 里，
  // 而是从本机已登录的 agent 凭证发现，记在 logins.json。
  for (const lg of Array.isArray(logins) ? logins : []) {
    if (!lg) continue;
    const agent = String(lg.agent || '');
    if (!agent || agent.startsWith('plugin:')) continue; // 插件账号已由上面覆盖
    if (seen.has(agent)) {
      // 同一内置 provider 有多个账号时只加一条，但累计账号数
      const row = out.find((x) => x.id === agent);
      if (row) {
        row.accounts = (row.accounts || 1) + 1;
        row.signedIn = true;
      }
      continue;
    }
    seen.add(agent);
    out.push({
      id: agent,
      name: BUILTIN_NAMES[agent] || agent,
      origin: 'official',
      builtin: true,
      baseUrl: '',
      anthropic: '',
      models: 0,
      signedIn: true,
      accounts: 1,
      account: lg.user || '',
    });
  }

  out.sort((a, b) => {
    // 我们的插件排前，官方次之
    const rank = (x) => (x.origin === 'plugin' ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return out;
}

/** 探测 magpie 版本；binary 不存在或执行失败返回 null */
function detectVersion(binaryPath, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath || !fs.existsSync(binaryPath)) return resolve(null);
    execFile(binaryPath, ['--version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /(\d+\.\d+\.\d+)/.exec(String(stdout || ''));
      resolve(m ? m[1] : null);
    });
  });
}

/**
 * 用 `magpie update check` 查最新版本。
 * 它走 magpie 自己的更新通道（usemagpie.ai），不受 GitHub API 60 次/小时限流影响。
 * 输出形如：
 *   magpie 0.1.3604 is out (you have 0.1.3598) · https://github.com/.../v0.1.3604
 *   或 "you have the newest version" 之类。
 */
function checkViaCli(binaryPath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath || !fs.existsSync(binaryPath)) return resolve(null);
    execFile(binaryPath, ['update', 'check'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      // 提取 "X.Y.Z is out"
      const m = /(\d+\.\d+\.\d+)\s+is out/i.exec(out);
      if (m) {
        const urlMatch = /(https:\/\/\S+)/.exec(out);
        return resolve({ tag: m[1], url: urlMatch ? urlMatch[1] : '', notes: out.trim() });
      }
      // 已是最新
      if (/newest|up to date|latest/i.test(out) && !err) {
        return resolve({ tag: null, url: '', notes: out.trim(), upToDate: true });
      }
      resolve(null);
    });
  });
}

/** 查 GitHub 最新 release tag（去掉前缀 v） */
function latestRelease() {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${MAGPIE_RELEASES_REPO}/releases/latest`,
      headers: {
        'User-Agent': 'wanneng2api-manager',
        Accept: 'application/vnd.github+json',
      },
      timeout: 8000,
    };
    const req = require('https').get(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ tag: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url || '', notes: j.body || '' });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 读取 magpie 的路由组（routing groups），附带成员与策略 */
function listGroups() {
  const dir = magpieConfigDir();
  const j = readJson(path.join(dir, 'providers.json'), { groups: [] });
  const groups = j.groups || j.routingGroups || [];
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g) continue;
    const name = g.name || g.id;
    if (!name) continue;
    out.push({
      name,
      routing: g.routing || g.mode || 'smart',
      models: Array.isArray(g.models) ? g.models : (Array.isArray(g.members) ? g.members : []),
    });
  }
  return out;
}

// ── 内核自更新 ────────────────────────────────────────────────────────
// magpie 自带 `magpie update`：下载最新 release 并原位替换可执行文件，
// 成功后需要重启 magpie 网关进程才生效。这里只负责把命令跑起来并记录状态。
let updating = false;
let lastUpdate = null;

function isUpdating() {
  return updating;
}

function updateState() {
  return { updating, last: lastUpdate };
}

function runUpdate(binaryPath, { timeoutMs = 600000 } = {}) {
  if (updating) return false;
  updating = true;
  lastUpdate = { startedAt: Date.now(), ok: null, message: '正在更新…' };
  execFile(binaryPath, ['update'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
    updating = false;
    const out = `${stdout || ''}${stderr || ''}`.trim();
    lastUpdate = {
      startedAt: lastUpdate.startedAt,
      finishedAt: Date.now(),
      ok: !err,
      message: err ? `更新失败：${out || err.message}` : (out || '更新完成'),
    };
  });
  return true;
}

function semverGt(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

module.exports = {
  magpieConfigDir,
  listProviders,
  listGroups,
  checkViaCli,
  detectVersion,
  latestRelease,
  semverGt,
  isUpdating,
  updateState,
  runUpdate,
  MAGPIE_RELEASES_REPO,
};