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

/** 中文名与说明：magpie 的 preset 只有英文名，这里补上中文对照 */
const PRESET_ZH = {
  anthropic: ['Anthropic', 'Claude 官方 API'],
  openai: ['OpenAI', 'GPT 官方 API'],
  google: ['Google Gemini', 'Gemini 官方 API'],
  'google-vertex': ['Google Vertex AI', 'GCP 上的 Gemini/Claude'],
  deepseek: ['DeepSeek', '深度求索官方 API'],
  xai: ['xAI', 'Grok 官方 API'],
  moonshot: ['Kimi', '月之暗面国际版'],
  'moonshot-cn': ['Kimi（国内）', '月之暗面国内版'],
  'kimi-code': ['Kimi Code', 'Kimi 编程订阅'],
  'kimi-code-cn': ['Kimi Code（国内）', 'Kimi 编程订阅国内版'],
  zhipu: ['智谱 GLM', 'GLM 官方 API'],
  zai: ['Z.ai', '智谱国际站'],
  minimax: ['MiniMax', 'MiniMax 国际版'],
  'minimax-cn': ['MiniMax（国内）', 'MiniMax 国内版'],
  stepfun: ['阶跃星辰', 'Step 系列'],
  'stepfun-cn': ['阶跃星辰（国内）', ''],
  xiaomi: ['小米 MiMo', 'MiMo 模型'],
  longcat: ['LongCat', '美团 LongCat'],
  'baidu-qianfan': ['百度千帆', '文心一言'],
  'tencent-cloud': ['腾讯云', '混元等'],
  huaweicloud: ['华为云 MaaS', '盘古等'],
  volcengine: ['火山方舟', '豆包'],
  qwen: ['通义千问', 'Qwen 国际版'],
  'qwen-cn': ['通义千问（国内）', ''],
  openrouter: ['OpenRouter', '聚合中转，一个 key 用多家'],
  vercel: ['Vercel AI Gateway', '聚合中转'],
  siliconflow: ['硅基流动', '国内聚合中转'],
  together: ['Together AI', '开源模型托管'],
  fireworks: ['Fireworks', '开源模型托管'],
  groq: ['Groq', '超快推理'],
  mistral: ['Mistral', 'Mistral 官方'],
  voyage: ['Voyage AI', '向量模型'],
  bedrock: ['Amazon Bedrock', 'AWS 模型托管'],
  azure: ['Azure OpenAI', '微软云 OpenAI'],
  ollama: ['Ollama（本地）', '本机模型，无需 key'],
  lmstudio: ['LM Studio（本地）', '本机模型，无需 key'],
  omlx: ['oMLX（本地）', 'Apple 芯片本地推理'],
  'mlx-serve': ['MLX-Serve（本地）', ''],
  'remote-magpie': ['远程 magpie', '用另一台电脑上的 magpie'],
  modelscope: ['魔搭 ModelScope', '阿里模型社区'],
  nvidia: ['NVIDIA NIM', ''],
  aihubmix: ['AiHubMix', '聚合中转'],
  'opencode-zen': ['OpenCode Zen', ''],
  kilo: ['Kilo Gateway', ''],
}

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

// ── 社区插件目录（magpie Plugins › Discover） ────────────────────────
// magpie 的 CLI 没有 discover 命令，这个页面读的是社区插件仓库的 registry.json：
//   https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json
// 每条给出 package / name / icon / providers / kind / summary(zh,en) / replaces。

const PLUGIN_REGISTRY_URL =
  'https://raw.githubusercontent.com/magpie-community/plugins/main/registry.json';
const PLUGIN_REGISTRY_CACHE_MS = 6 * 3600 * 1000;

let registryCache = null;

function fetchJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'wanneng2api-manager' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 本地克隆的 registry 作为离线兜底（开发机上常有） */
function localRegistryPath() {
  const cands = [
    path.resolve(__dirname, '..', '..', 'upstream', 'magpie-plugins', 'registry.json'),
    path.resolve(__dirname, '..', '..', 'magpie-plugins', 'registry.json'),
    'D:/app/magpie-plugins/registry.json',
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function listPluginCatalog({ force = false } = {}) {
  if (!force && registryCache && Date.now() - registryCache.at < PLUGIN_REGISTRY_CACHE_MS) {
    return registryCache.data;
  }
  let reg = await fetchJson(PLUGIN_REGISTRY_URL);
  let source = 'remote';
  if (!reg) {
    const local = localRegistryPath();
    if (local) {
      reg = readJson(local, null);
      source = 'local';
    }
  }
  if (!reg || !Array.isArray(reg.plugins)) return { plugins: [], source: 'none' };

  // 已安装插件（按 package spec 匹配，含 @latest 后缀差异）
  const installedSpecs = (readJson(path.join(magpieConfigDir(), 'plugins.json'), { plugins: [] }).plugins || [])
    .map((p) => String(p.spec || '').replace(/@latest$/, ''));

  const plugins = reg.plugins.map((p) => {
    const pkg = String(p.package || '');
    const basePkg = pkg.replace(/@latest$/, '');
    return {
      package: pkg,
      name: p.name || pkg,
      icon: p.icon || '',
      kind: p.kind || 'provider',
      providers: Array.isArray(p.providers) ? p.providers : [],
      community: p.community !== false,
      replaces: p.replaces || '',
      summary: p.summary || {},
      installed: installedSpecs.some((s) => s === basePkg || s === pkg),
    };
  });

  const data = { plugins, source, fetchedAt: Date.now(), total: plugins.length };
  registryCache = { at: Date.now(), data };
  return data;
}

/** 安装社区插件：magpie plugin add <package> */
function addPlugin(binaryPath, pkg, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ ok: false, stdout: '', stderr: '未找到 magpie 可执行文件' });
    if (!/^@?[\w.-]+\/[\w.-]+(@[\w.-]+)?$|^@?[\w.-]+$/.test(String(pkg || ''))) {
      return resolve({ ok: false, stdout: '', stderr: `非法包名: ${pkg}` });
    }
    execFile(binaryPath, ['plugin', 'add', pkg], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim() || (err && err.message) || '',
      });
    });
  });
}

function removePlugin(binaryPath, specOrName, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ ok: false, stdout: '', stderr: '未找到 magpie 可执行文件' });
    execFile(binaryPath, ['plugin', 'rm', specOrName], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() || (err && err.message) || '' });
    });
  });
}

// ── 预置 provider 目录（magpie presets） ──────────────────────────────
// magpie presets 只有文本输出，形状是：
//   分组标题              （两空格缩进，无其余内容）
//   显示名 <空格> id <空格> magpie provider add <id> [<key> ...]
// 分组：partners (sponsors) / vendors / relays / local / another computer's magpie

const GROUP_ZH = {
  'partners (sponsors)': '赞助商',
  vendors: '厂商直连',
  relays: '聚合中转',
  local: '本地模型',
  "another computer's magpie": '远程 magpie',
};

function parsePresets(text) {
  const out = [];
  let group = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s{2}\S/.test(raw) && !/magpie provider add/.test(line)) {
      const g = line.trim();
      group = GROUP_ZH[g] || g;
      continue;
    }
    // "Name    id    magpie provider add id <key> [k=v ...]"
    const m = /^\s{2}(.+?)\s{2,}(\S+)\s{2,}(magpie provider add\s+(.*))$/.exec(line);
    if (!m) continue;
    const [, name, id, , argsStr] = m;
    const zh = PRESET_ZH[id];
    // 安装后告诉用户要填什么：<key> 表示需要 API Key；project=xx 等是具名参数
    const needsKey = /<key>/.test(argsStr);
    const params = [...argsStr.matchAll(/([a-zA-Z][\w-]*)=<[^>]+>/g)].map((x) => x[1]);
    out.push({
      id,
      name: zh ? zh[0] : name.trim(),
      originalName: name.trim(),
      group,
      description: zh ? zh[1] : '',
      needsKey,
      params,
      command: `magpie provider add ${argsStr.replace(/^add\s+/, '')}`,
    });
  }
  return out;
}

let presetsCache = null;

function listPresets(binaryPath, { force = false, timeoutMs = 20000 } = {}) {
  if (!force && presetsCache && Date.now() - presetsCache.at < 300000) {
    return Promise.resolve(presetsCache.list);
  }
  return new Promise((resolve) => {
    if (!binaryPath || !fs.existsSync(binaryPath)) return resolve([]);
    execFile(binaryPath, ['presets'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve([]);
      const list = parsePresets(`${stdout || ''}${stderr || ''}`);
      presetsCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

/**
 * 安装一个预置 provider。
 * @param {string} binaryPath magpie 可执行文件
 * @param {{id:string, key?:string, args?:string[]}} opts
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string}>}
 */
function addProvider(binaryPath, { id, key, args = [] }, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ ok: false, stdout: '', stderr: '未找到 magpie 可执行文件' });
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id || ''))) {
      return resolve({ ok: false, stdout: '', stderr: `非法 provider id: ${id}` });
    }
    const argv = ['provider', 'add', id];
    if (key) argv.push(key);
    for (const a of args) argv.push(String(a));
    execFile(binaryPath, argv, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      // 安装后 presets 缓存不必失效（目录没变），但 provider 列表要重读
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim() || (err && err.message) || '',
      });
    });
  });
}

function removeProvider(binaryPath, id, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath || !/^[a-z0-9][a-z0-9-]*$/.test(String(id || ''))) {
      return resolve({ ok: false, stdout: '', stderr: '非法 provider id' });
    }
    execFile(binaryPath, ['provider', 'rm', id], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() || (err && err.message) || '' });
    });
  });
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
  listPluginCatalog,
  addPlugin,
  removePlugin,
  PLUGIN_REGISTRY_URL,
  listPresets,
  parsePresets,
  addProvider,
  removeProvider,
  detectVersion,
  latestRelease,
  semverGt,
  isUpdating,
  updateState,
  runUpdate,
  MAGPIE_RELEASES_REPO,
};