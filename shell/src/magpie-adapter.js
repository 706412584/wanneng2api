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
const proxy = require('./proxy');

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

/**
 * 从分组名派生一个内核接受的 id。
 *
 * 内核规则：小写字母、数字、点、横线（实测报错原文
 * 「a group's id must be lowercase letters, digits, dots and dashes」）。
 * 中文名派生不出 id（会得到空串并 400），所以 ASCII 部分能转就转，
 * 转不出来就用「名字的稳定短哈希」兜底——保证同一个中文名每次都得到
 * 同一个 id，重建时是替换而不是不断堆积。
 */
function deriveGroupId(name, members) {
  const ascii = String(name || '').toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  if (ascii && /[a-z0-9]/.test(ascii)) return ascii;
  // 全中文（或其它非 ASCII）：按**名字**做稳定哈希（不含成员——名字才是标识，
  // 混入成员会让「同名重建」变成另一个 id，从而不断堆积新分组）。
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `group-${h.toString(36)}`;
}
const OUR_PREFIX = 'wanneng-';

/** 北京时间的「今天」，与前端/网关的签到判定同一口径 */
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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
    const req = require('https').get(proxy.withAgent('magpieKernel', opts), (res) => {
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
    const req = mod.get(url, proxy.withAgent('pluginRegistry',
      { headers: { 'User-Agent': 'wanneng2api-manager' }, timeout: timeoutMs }), (res) => {
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
  let reg;
  let source;
  if (!force && registryCache && Date.now() - registryCache.at < PLUGIN_REGISTRY_CACHE_MS) {
    ({ reg, source } = registryCache);
  } else {
    reg = await fetchJson(PLUGIN_REGISTRY_URL);
    source = 'remote';
    if (!reg) {
      const local = localRegistryPath();
      if (local) {
        reg = readJson(local, null);
        source = 'local';
      }
    }
    if (!reg || !Array.isArray(reg.plugins)) return { plugins: [], source: 'none' };
    registryCache = { reg, source, at: Date.now() };
  }

  // 已安装插件（按 package spec 匹配，含 @latest 后缀差异）。
  // spec 保持原样：本地路径型插件（如 D:\app\wanneng2api\plugins\prompt-guard）
  // 的 spec 就是安装位置，去掉 @latest 会破坏它，只对 npm 包名做归一。
  const installedEntries = (readJson(path.join(magpieConfigDir(), 'plugins.json'), { plugins: [] }).plugins || [])
    .map((p) => String(p.spec || ''));

  // 本地研发的插件（spec 是本机绝对路径）不在社区 registry 里，按注册表映射
  // 会整条丢掉、界面上完全看不到。这里把它们补成目录条目，让「已安装插件」
  // 区能显示，并且能一眼看到它装在哪。
  // 注意：reg 来自 registryCache，不能在它上面 push（缓存复用会越堆越多），
  // 所以先复制一份目录再补。
  const catalog = reg.plugins.slice();
  const inCatalog = new Set(catalog.map((p) => String(p.package || '')));
  for (const spec of installedEntries) {
    if (!path.isAbsolute(spec) || inCatalog.has(spec)) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(spec, 'package.json'), 'utf8')); } catch { /* 无 manifest */ }
    const magpieMeta = (meta.magpie && typeof meta.magpie === 'object') ? meta.magpie : {};
    const providers = Array.isArray(magpieMeta.providers) ? magpieMeta.providers.map(String) : [];
    catalog.push({
      package: spec,
      name: String(meta.name || path.basename(spec)),
      // 有 providers 声明才是 provider 型；没有则显式给 kind，否则会被
      // 当成 provider 平台卡（本地中间件插件没有 provider，不能出现在平台区）。
      kind: magpieMeta.kind || (providers.length ? 'provider' : (magpieMeta.middleware ? 'middleware' : 'plugin')),
      providers,
      community: false,
      summary: { zh: String(meta.description || '本地插件（从本机目录安装）') },
    });
  }
  const installedSpecs = installedEntries.map((s) => s.replace(/@latest$/, ''));
  // npm 包实际落盘在 magpie 配置目录的 plugins/node_modules/<name>
  const modulesDir = path.join(magpieConfigDir(), 'plugins', 'node_modules');
  const installPathOf = (spec) => {
    const raw = String(spec || '');
    if (!raw) return '';
    if (path.isAbsolute(raw)) return raw;             // 本地路径型：spec 本身即位置
    const name = raw.replace(/@latest$/, '');
    if (!/^(@?[\w.-]+\/)?[\w.-]+$/.test(name)) return '';
    return path.join(modulesDir, ...name.split('/')); // @scope/pkg → scope/pkg
  };

  // 已登录的插件账号：logins.json 里 agent 形如 "plugin:kiro"
  const signedInProviders = new Set(
    (readJson(path.join(magpieConfigDir(), 'logins.json'), []) || [])
      .map((l) => String(l.agent || ''))
      .filter((a) => a.startsWith('plugin:'))
      .map((a) => a.slice('plugin:'.length))
  );

  const plugins = catalog.map((p) => {
    const pkg = String(p.package || '');
    const basePkg = pkg.replace(/@latest$/, '');
    const providers = Array.isArray(p.providers) ? p.providers : [];
    const signed = providers.filter((x) => signedInProviders.has(x));
    // 命中已安装的那条 spec（优先精确匹配，其次去掉 @latest 后匹配）
    const matched = installedEntries.find((s) => s === pkg || s.replace(/@latest$/, '') === basePkg);
    return {
      package: pkg,
      name: p.name || pkg,
      icon: p.icon || '',
      kind: p.kind || 'provider',
      providers,
      community: p.community !== false,
      replaces: p.replaces || '',
      summary: p.summary || {},
      installed: installedSpecs.some((s) => s === basePkg || s === pkg),
      signedIn: signed.length > 0,
      signedProviders: signed,
      // 安装位置：仅已安装的才有意义，供界面显示「装在哪」。
      installPath: matched ? installPathOf(matched) : '',
    };
  });

  return { plugins, source, fetchedAt: registryCache.at, total: plugins.length };
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
    if (key) argv.push(String(key));
    // 具名参数只接受 key=value（如 project=xxx）；拒绝以 - 开头的串，
    // 否则等于让调用方往 magpie CLI 里塞任意 flag。
    for (const a of args) {
      const s = String(a);
      if (!/^[A-Za-z][\w-]*=/.test(s)) {
        return resolve({ ok: false, stdout: '', stderr: `非法参数: ${s}` });
      }
      argv.push(s);
    }
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

// ── 插件登录（OAuth / 设备码 / 短信等） ────────────────────────────────
// `magpie plugin login <provider> [<method>]` 是交互式的：不给 method 时会列出
// 选项并等 stdin。给了 method 编号就走设备码流程，先打印一个浏览器授权链接，
// 然后阻塞等待用户在浏览器里完成授权。
//
// 可视化做法：后台起进程、捕获链接、把链接交给前端打开；进程继续跑，
// 结束（成功/失败/超时）后把结果记进 loginState 供轮询。

const loginStates = new Map();   // provider -> { status, url, message, startedAt, finishedAt }

function loginState(provider) {
  return loginStates.get(provider) || null;
}

function listLoginStates() {
  return Object.fromEntries(loginStates);
}

/** provider id 合法性：magpie 的 id 都是小写字母数字加连字符 */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 解析 `magpie plugin login <p>` 不带 method 时的选项列表 */
function probeLoginMethods(binaryPath, provider, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ methods: [], error: '未找到 magpie 可执行文件' });
    if (!PROVIDER_ID_RE.test(String(provider || ''))) {
      return resolve({ methods: [], error: `非法 provider: ${provider}` });
    }
    // 不给 method 时 CLI 会列出选项并等 stdin：读够就关掉 stdin，让它立刻退出，
    // 否则每次探测都要白等一个超时。
    const child = execFile(binaryPath, ['plugin', 'login', provider], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      // 形如：\nHow do you sign in to Qoder?\n  1. Sign in with Qoder\n  2. Sign in with Qoder PAT\n>
      const methods = [...text.matchAll(/^\s*(\d+)\.\s*(.+)$/gm)].map((m) => ({
        index: Number(m[1]),
        label: m[2].trim(),
      }));
      if (methods.length) resolve({ methods });
      else resolve({ methods: [], error: text.trim().slice(0, 300) || (err && err.message) || '' });
    });
    try { child.stdin.end(); } catch { /* 可能已关闭 */ }
    child.on('error', () => resolve({ methods: [], error: '无法启动 magpie' }));
  });
}

/**
 * 启动登录流程。
 * @returns {Promise<{started:boolean, url?:string, message?:string}>}
 */
function startLogin(binaryPath, provider, method, { urlTimeoutMs = 45000, totalTimeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ started: false, message: '未找到 magpie 可执行文件' });
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(provider || ''))) {
      return resolve({ started: false, message: `非法 provider: ${provider}` });
    }
    // method 只接受数字序号：magpie 会把它当位置参数，传字符串等于给 CLI 塞了
    // 一个任意 argv（execFile 无 shell，不会命令注入，但能改行为）。
    const methodArg = method === undefined || method === null || method === '' ? null : String(method);
    if (methodArg !== null && !/^\d{1,2}$/.test(methodArg)) {
      return resolve({ started: false, message: `非法登录方式: ${method}` });
    }

    // 同一 provider 重复登录：先收掉上一次的进程与状态，避免失控子进程堆积
    const prev = loginStates.get(provider);
    if (prev && prev.child) {
      try { prev.child.kill(); } catch { /* 已退出 */ }
    }

    const argv = ['plugin', 'login', provider];
    if (methodArg !== null) argv.push(methodArg);

    let child;
    try {
      child = require('child_process').spawn(binaryPath, argv, {
        cwd: path.dirname(binaryPath),
        env: { ...process.env },
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ started: false, message: `启动登录进程失败：${e.message}` });
    }

    const state = {
      status: 'pending',
      url: '',
      message: '',
      method: methodArg,
      startedAt: Date.now(),
      finishedAt: null,
      child,
    };
    loginStates.set(provider, state);

    let buf = '';
    let settled = false;        // 主 Promise 是否已 resolve
    let urlTimer = null;
    let killTimer = null;

    const done = (payload) => {
      if (settled) return;
      settled = true;
      if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
      resolve(payload);
    };

    const onData = (chunk) => {
      buf += String(chunk);
      if (!state.url && !state.code) {
        // 设备码链接：https://...（同一行常有 "If it didn't open, go to:"）
        const m = /(https?:\/\/\S+)/.exec(buf);
        if (m) {
          state.url = m[1].replace(/[),.]+$/, '');
          state.status = 'awaiting-browser';
          done({ started: true, url: state.url, message: '请在浏览器完成授权' });
        } else {
          // 也可能直接给到 "code: XXXXX"
          const code = /enter (?:this )?code[:\s]+([A-Z0-9-]{4,})/i.exec(buf);
          if (code) {
            state.code = code[1];
            state.status = 'awaiting-code';
            done({ started: true, message: `设备码：${code[1]}` });
          }
        }
      }
      state.output = (state.output || '') + String(chunk);
      if (state.output.length > 8000) state.output = state.output.slice(-8000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    // spawn 失败（如 ENOENT）只会触发 'error' 与 'close'，不会触发 'exit'。
    // 没有这个监听，Promise 永不 settle，纯 Node 模式下进程直接挂死。
    child.on('error', (e) => {
      state.status = 'failed';
      state.message = `启动登录进程失败：${e.message}`;
      state.finishedAt = Date.now();
      delete state.child;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      done({ started: false, message: state.message });
    });

    child.on('close', (code) => {
      state.finishedAt = Date.now();
      delete state.child;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (!state.url && !state.code) {
        // 没拿到链接就退出了：把对话输出交给用户自己处理
        state.status = 'interactive';
        state.message = '该 provider 需要交互式登录（输入验证码等），请用命令行完成';
        return done({ started: false, interactive: true, message: state.message, output: state.output });
      }
      if (state.status === 'cancelled') return done({ started: true, message: state.message });
      const ok = code === 0;
      state.status = ok ? 'signed-in' : 'failed';
      state.message = ok ? '登录成功' : `登录未完成（exit ${code}）`;
      done({ started: true, url: state.url, message: state.message });
    });

    // 总时长兜底：设备码链接可能一直等不到用户操作，超时就收进程
    killTimer = setTimeout(() => {
      if (!state.child) return;
      try { state.child.kill(); } catch { /* 已退出 */ }
      state.status = 'failed';
      state.message = '登录超时（10 分钟未完成）';
      state.finishedAt = Date.now();
      done({ started: true, url: state.url, message: state.message });
    }, totalTimeoutMs);

    // 拿到链接才算启动成功；超时也算"已在后台等待"
    urlTimer = setTimeout(() => {
      urlTimer = null;
      done({
        started: true,
        message: '登录进程已启动，暂未拿到授权链接',
        note: '如长时间无响应，用命令行执行 magpie plugin login',
      });
    }, urlTimeoutMs);
  });
}

function cancelLogin(provider) {
  const st = loginStates.get(provider);
  if (!st) return false;
  if (st.child) {
    try { st.child.kill(); } catch { /* 已退出 */ }
    delete st.child;
  }
  st.status = 'cancelled';
  st.message = '已取消';
  st.finishedAt = Date.now();
  return true;
}

function logoutProvider(binaryPath, provider, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!binaryPath) return resolve({ ok: false, stderr: '未找到 magpie 可执行文件' });
    if (!PROVIDER_ID_RE.test(String(provider || ''))) {
      return resolve({ ok: false, stderr: `非法 provider: ${provider}` });
    }
    execFile(binaryPath, ['plugin', 'logout', provider], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) loginStates.delete(provider);
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

// ── 一键安装 magpie（未安装时的引导） ─────────────────────────────────
// magpie 是约 79MB 的独立可执行文件，不随安装包分发。这里直接从它的
// release 仓库取 CLI 版（magpie-cli-<os>-<arch>）存到数据目录，
// 让打包版用户不必自己去找下载页。
let installState = null; // { status, received, total, message }

function installProgress() {
  return installState;
}

/**
 * 下载 magpie 到 <dataDir>/magpie/。
 * @returns {Promise<{ok:boolean, path?:string, message?:string}>}
 */
function installMagpie(dataDir, { timeoutMs = 300000, onProgress } = {}) {
  const asset = process.platform === 'win32'
    ? `magpie-cli-windows-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.exe`
    : process.platform === 'darwin'
      ? `magpie-cli-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
      : `magpie-cli-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;

  const dir = path.join(dataDir, 'magpie');
  const out = path.join(dir, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
  installState = { status: 'resolving', received: 0, total: 0, message: '正在获取最新版本…' };

  return new Promise((resolve) => {
    const metaUrl = `https://api.github.com/repos/${MAGPIE_RELEASES_REPO}/releases/latest`;
    const req = require('https').get(metaUrl, {
      headers: { 'User-Agent': 'wanneng2api-shell', Accept: 'application/vnd.github+json' },
      timeout: 20000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const msg = res.statusCode === 403
            ? 'GitHub API 限流，请稍后重试，或在「设置」里填 GitHub Token'
            : `获取版本信息失败（HTTP ${res.statusCode}）`;
          installState = { status: 'failed', received: 0, total: 0, message: msg };
          return resolve({ ok: false, message: msg });
        }
        let info;
        try { info = JSON.parse(body); } catch {
          installState = { status: 'failed', received: 0, total: 0, message: '版本信息解析失败' };
          return resolve({ ok: false, message: '版本信息解析失败' });
        }
        const assetInfo = (info.assets || []).find((a) => a.name === asset);
        if (!assetInfo) {
          const msg = `发布包里没有 ${asset}`;
          installState = { status: 'failed', received: 0, total: 0, message: msg };
          return resolve({ ok: false, message: msg });
        }
        download(assetInfo.browser_download_url, assetInfo.size);
      });
    });
    req.on('error', (e) => {
      installState = { status: 'failed', received: 0, total: 0, message: `网络错误：${e.message}` };
      resolve({ ok: false, message: `网络错误：${e.message}` });
    });
    req.on('timeout', () => {
      req.destroy();
      installState = { status: 'failed', received: 0, total: 0, message: '获取版本信息超时' };
      resolve({ ok: false, message: '获取版本信息超时' });
    });

    function download(url, size) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
      // 先写 .part 再改名，避免半包被当成可执行文件
      const part = `${out}.part`;
      installState = { status: 'downloading', received: 0, total: size, message: '正在下载 magpie…' };
      const file = fs.createWriteStream(part);
      const follow = (u, depth = 0) => {
        if (depth > 5) { finish(false, '下载重定向次数过多'); return; }
        const dl = require('https').get(u, proxy.withAgent('magpieKernel',
          { headers: { 'User-Agent': 'wanneng2api-shell' }, timeout: timeoutMs }), (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            finish(false, `下载失败（HTTP ${res.statusCode}）`);
            return;
          }
          res.on('data', (c) => {
            installState.received += c.length;
            if (onProgress) onProgress(installState);
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try {
                fs.renameSync(part, out);
                if (process.platform !== 'win32') fs.chmodSync(out, 0o755);
                installState = { status: 'done', received: installState.received, total: size, message: '安装完成' };
                resolve({ ok: true, path: out });
              } catch (e) {
                finish(false, `写入失败：${e.message}`);
              }
            });
          });
          res.on('error', (e) => finish(false, `下载中断：${e.message}`));
        });
        dl.on('error', (e) => finish(false, `下载失败：${e.message}`));
        dl.on('timeout', () => { dl.destroy(); finish(false, '下载超时'); });
      };
      const finish = (ok, message) => {
        try { file.close(); } catch { /* ignore */ }
        try { fs.unlinkSync(part); } catch { /* ignore */ }
        installState = { status: ok ? 'done' : 'failed', received: 0, total: 0, message };
        resolve({ ok, message });
      };
      follow(url);
    }
  });
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

/**
 * 路由组只读/排序：同一模型可能被多个平台提供，内核把它们合成一个 auto 组。
 * 用户调整顺序时，内核会把该组“变成你的”（auto → 用户组），
 * 所以保存必须原样带回它已有的其它字段，不能只发 members。
 */
class RoutingGroups {
  constructor({ getConfig, timeoutMs = 15000 }) {
    this.panel = new PluginPanel({ getConfig, timeoutMs });
  }

  async list() {
    const data = await this.panel._api('groups');
    const groups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
    return groups.filter((g) => g && typeof g.id === 'string').map((g) => ({
      id: g.id,
      name: typeof g.name === 'string' ? g.name : g.id,
      auto: !!g.auto,
      routing: typeof g.routing === 'string' ? g.routing : '',
      ready: !!g.ready,
      members: (Array.isArray(g.members) ? g.members : []).filter((m) => typeof m === 'string'),
      memberInfo: (Array.isArray(g.memberInfo) ? g.memberInfo : [])
        .filter((m) => m && typeof m.id === 'string')
        .map((m) => ({ id: m.id, provider: typeof m.provider === 'string' ? m.provider : '',
          name: typeof m.name === 'string' ? m.name : '', model: typeof m.model === 'string' ? m.model : '',
          ready: !!m.ready, providerOff: !!m.providerOff })),
      ref: typeof g.ref === 'string' ? g.ref : 'group/' + g.id,
    }));
  }

  /** 同一模型被多个平台提供时，按成员数降序给出，便于优先展示“需要定顺序”的组 */
  async shared() {
    const groups = await this.list();
    return groups.filter((g) => g.members.length > 1).sort((a, b) => b.members.length - a.members.length
      || a.name.localeCompare(b.name));
  }

  /**
   * 列出可绑定的平台：每个 provider 的 id/名称/是否启用/模型数。
   * 只给「已安装的 provider」，不做成通用 provider 编辑器。
   *
   * 模型列表不是白拿的：magpie 只有在**拉取过**之后才知道 provider 提供哪些模型。
   * 我们接入的四家里，只有 lingxi 的 providers.json 里写死了 models 列表，
   * 其余三家的 chosen 为空 → models 为空数组 → 界面显示「没有已启用的模型」，
   * 于是「同模型优先级」里根本选不出这几个平台。
   * 所以这里对「就绪、但一个模型都没有」的 provider 先触发一次拉取再读。
   */
  async bindable() {
    let data = await this.panel._api('providers');
    let rows = Array.isArray(data?.providers) ? data.providers : [];
    const needsFetch = rows.filter((p) => p && typeof p.id === 'string' && !p.account?.builtin
      && !p.off && p.ready && !(Array.isArray(p.models) && p.models.length));
    if (needsFetch.length) {
      // 并发拉取：这些是本机网关，一次往返很快；串行会让打开面板明显变卡
      await Promise.all(needsFetch.map((p) =>
        this.panel._api('provider/models', { id: p.id }).catch(() => null)));
      data = await this.panel._api('providers');
      rows = Array.isArray(data?.providers) ? data.providers : [];
    }
    return rows.filter((p) => p && typeof p.id === 'string' && !p.account?.builtin)
      .map((p) => ({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.id,
        off: !!p.off,
        ready: !!p.ready,
        models: (Array.isArray(p.models) ? p.models : []).filter((m) => m && m.on && typeof m.id === 'string')
          .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id })),
      }));
  }

  /**
   * 用勾选的平台新建（或更新）一个顺序路由组。
   * members 由后台按「平台 + 该平台已启用模型」展开，前端不能塞任意 id。
   */
  async bind({ id, name, providers }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('分组名称无效');
    if (!Array.isArray(providers) || !providers.length || providers.length > 50
      || !providers.every((p) => typeof p === 'string')) throw new Error('请至少选择一个平台');
    const avail = await this.bindable();
    const picked = providers.filter((pid) => avail.some((p) => p.id === pid));
    if (picked.length !== providers.length) throw new Error('所选平台不存在');
    const members = [];
    for (const pid of picked) {
      const row = avail.find((p) => p.id === pid);
      if (!row.models.length) throw new Error(`${row.name} 没有已启用的模型`);
      for (const m of row.models) members.push(`${pid}/${m.id}`);
    }
    if (new Set(members).size !== members.length) throw new Error('所选平台产生了重复成员');
    const hasId = typeof id === 'string' && !!id;
    // 更新既有组时，除「名称 + 成员 + 顺序策略」外一律沿用原值：
    // 否则 note/rules/weights/modelPrefs 等会被默认空值抹掉。
    let base = {
      note: '', match: [], pick: '', affinity: '', sink: false, noSink: false,
      firstToken: 0, patience: 0, rules: [], effort: '', classifier: '', intentSure: null,
      context: 0, levels: [], family: '', fast: [], off: [], weights: {}, effortMaps: {},
      accounts: [], keys: [], unlists: false,
    };
    if (hasId) {
      const current = await this.panel._api('groups');
      const all = Array.isArray(current) ? current : Array.isArray(current?.groups) ? current.groups : [];
      const target = all.find((g) => g && g.id === id);
      if (!target) throw new Error('要更新的分组不存在');
      if (target.auto) throw new Error('自动合并的分组不能用绑定覆盖，请新建');
      // 只允许更新「已经全部来自本接口所选平台」的组，避免吞掉手工成员
      const known = new Set();
      for (const p of avail) for (const m of p.models) known.add(`${p.id}/${m.id}`);
      const foreign = (Array.isArray(target.members) ? target.members : []).filter((m) => !known.has(m));
      if (foreign.length) throw new Error('该分组含绑定之外的成员，不能在此覆盖');
      // 保留原有的一切非成员配置
      base = {
        note: target.note || '', match: target.match || [], pick: target.pick || '',
        affinity: target.affinity || '',
        sink: !!target.sink,
        noSink: !!target.noSink, firstToken: target.firstToken || 0, patience: target.patience || 0,
        rules: target.rules || [], effort: target.effort || '', classifier: target.classifier || '',
        intentSure: target.intentSure ?? null, context: target.context || 0, levels: target.levels || [],
        family: target.family || '', fast: target.fast || [], off: target.off || [],
        weights: target.weights || {}, effortMaps: target.effortMaps || {},
        accounts: target.accounts || [], keys: target.keys || [], unlists: !!target.unlists,
      };
    }
    const body = {
      // 内核按 name 派生 id，且要求 id 只能用小写字母/数字/点/横线。
      // 纯中文名派生出**空** id，直接 400「a group's id must be lowercase
      // letters, digits, dots and dashes, not ""」——用户只是起了个中文名。
      // 所以这里始终显式给出 id：有旧 id 就沿用，否则从中文名生成一个
      // slug（中文保留成拼音式不可行，退化为按序命名），保证中文名可用。
      id: hasId ? id : deriveGroupId(name.trim(), members),
      from: hasId ? id : undefined,
      name: name.trim(), members, placed: members,
      // 绑定入口的目标就是“按勾选顺序”，新建与更新都设为 order
      routing: 'order',
      ...base,
    };
    const result = await this.panel._api('groups/save', body);
    const groups = Array.isArray(result) ? result : Array.isArray(result?.groups) ? result.groups : [];
    const saved = groups.find((g) => g && g.id === body.id) || groups.find((g) => g && g.name === body.name);
    return { name: body.name, members, id: saved?.id || body.id || '' };
  }

  async reorder(id, members) {
    if (typeof id !== 'string' || !id) throw new Error('路由组标识无效');
    const data = await this.panel._api('groups');
    const groups = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
    const g = groups.find((x) => x && x.id === id);
    if (!g) throw new Error('路由组不存在');
    const current = (Array.isArray(g.members) ? g.members : []).filter((m) => typeof m === 'string');
    // 只允许重排，不允许借这个接口增删成员
    if (!Array.isArray(members) || members.length !== current.length
      || members.some((m) => typeof m !== 'string' || !current.includes(m))
      || new Set(members).size !== members.length) {
      throw new Error('只能调整现有成员的顺序');
    }
    // 空 routing 是**智能(Smart)**，不是顺序：内核 GROUP_HINT 的第一项（键 ""）
    // 就是智能调度。把空值改写成 'order' 会静默把用户的智能路由换成顺序路由。
    // 因此顺序调整只对显式的顺序型策略开放，其它一律拒绝，并保持原值回传。
    const routing = typeof g.routing === 'string' ? g.routing : '';
    // order = 严格按顺序；空 = 智能（顺序只作兜底，条件相同时才生效）。
    // 其它策略（drain/rotate/usage/pace/weight/free/fast/cheap/expiring/manual）
    // 根本不看顺序，改它不会有任何效果，直接拒绝而不是假装保存。
    if (routing && routing !== 'order') {
      throw new Error(`该组使用「${routing}」策略，成员顺序不影响路由，无法在此调整`);
    }
    // 含模式匹配（match / patterns / matched）的组：members 里混着自动匹配出来的
    // 成员，原样写回会把它们固化成硬编码成员。这类组请在控制台调整。
    const patterns = [g.match, g.matched, g.patterns].some((v) => Array.isArray(v) && v.length > 0);
    if (patterns) {
      throw new Error('该组包含按模式自动匹配的成员，不能只靠改顺序调整');
    }
    const body = {
      id: g.id, from: g.id, name: g.name || g.id, note: g.note || '',
      members: members, placed: members, match: g.match || [],
      // 原样回传：空字符串保持空（智能），不擅自改成 order
      routing,
      pick: g.pick || '', affinity: g.affinity || '',
      // 内核保存时 sink / noSink 都是**布尔**：
      //   sink: !!g.sink && sinkable(routing)   （429 时排到队尾）
      //   noSink: !!g.noSink                    （保留原位）
      // 之前写成字符串 ''，等于把“排到队尾”重置掉。
      sink: !!g.sink,
      noSink: !!g.noSink,
      firstToken: g.firstToken || 0, patience: g.patience || 0,
      rules: g.rules || [], effort: g.effort || '', classifier: g.classifier || '',
      intentSure: g.intentSure ?? null, context: g.context || 0, levels: g.levels || [],
      family: g.family || '', fast: g.fast || [], off: g.off || [], weights: g.weights || {},
      effortMaps: g.effortMaps || {}, accounts: g.accounts || [], keys: g.keys || [],
      unlists: !!g.unlists,
    };
    await this.panel._api('groups/save', body);
    const next = await this.panel._api('groups');
    const all = Array.isArray(next) ? next : Array.isArray(next?.groups) ? next.groups : [];
    const saved = all.find((x) => x && x.id === g.id) || g;
    return {
      id: g.id,
      members: saved.members || members,
      auto: !!saved.auto,
      // 让界面如实说明这次调整的实际效力
      routing: typeof saved.routing === 'string' ? saved.routing : '',
      strictOrder: saved.routing === 'order',
    };
  }
}

// 原生插件面板只访问已配置的本机内核，不暴露通用 HTTP 代理。
class PluginPanel {
  constructor({ getConfig, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024 }) {
    this.getConfig = getConfig;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.session = null;
    this.signins = new Map();
  }

  _target() {
    const cfg = this.getConfig();
    if (!cfg?.adminPanel) throw new Error('未配置 magpie 控制台地址');
    let url;
    try { url = new URL(cfg.adminPanel); } catch { throw new Error('magpie 控制台地址无效'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('插件管理仅允许访问本机 magpie 控制台');
    const key = cfg.run?.env?.MAGPIE_WEB_KEY || url.searchParams.get('k') || '';
    return { origin: url.origin, key };
  }

  _http(url, { cookie, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      let size = 0;
      const req = require('http').request(url, {
        method: payload === undefined ? 'GET' : 'POST', agent: false,
        headers: { ...(cookie ? { Cookie: cookie } : {}),
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
        signal,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > this.maxBytes) { res.destroy(); reject(new Error('内核管理响应过大')); }
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('内核管理响应中断')));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', (e) => reject(new Error(e.name === 'AbortError' ? '内核管理请求超时' : '无法连接本机 magpie 控制台')));
      req.end(payload);
    });
  }

  async _api(endpoint, body) {
    const target = this._target();
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (!this.session || this.session.origin !== target.origin || this.session.key !== target.key) {
      const url = new URL('/', target.origin);
      if (target.key) url.searchParams.set('k', target.key);
      const r = await this._http(url, { signal });
      if (r.status === 401 || r.status === 403) throw new Error('magpie 控制台鉴权失败，请检查其访问密钥配置');
      if (r.status >= 300 && r.status < 400) {
        const next = new URL(r.headers.location || '/', target.origin);
        if (next.origin !== target.origin) throw new Error('拒绝 magpie 控制台跨站跳转');
      } else if (r.status !== 200) throw new Error(`magpie 控制台不可用（HTTP ${r.status}）`);
      const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      this.session = { ...target, cookie };
    }
    const r = await this._http(new URL('/api/' + endpoint, target.origin), { body, cookie: this.session.cookie, signal });
    if (r.status === 401 || r.status === 403) {
      this.session = null;
      throw new Error('magpie 控制台会话已失效，请重试');
    }
    // 不自动重试写操作。错误正文经脱敏后把原因带出去：内核的拒绝理由
    // （如「a group's id must be lowercase letters…」）是用户唯一能据此
    // 行动的信息，只留一个状态码等于让人去猜。脱敏规则见 _redact。
    if (r.status < 200 || r.status >= 300) {
      const reason = this._redact(this._errorText(r.text));
      throw new Error(reason
        ? `内核未能完成该操作（HTTP ${r.status}）：${reason}`
        : `内核未能完成该操作（HTTP ${r.status}）`);
    }
    let data;
    // 204 / 空 body 是合法的“已完成，无返回”，不是不兼容数据
    if (!r.text || !r.text.trim()) return {};
    try { data = JSON.parse(r.text); } catch { throw new Error('内核管理接口返回了不兼容的数据'); }
    if (data?.error) {
      const reason = this._redact(String(data.error));
      throw new Error(reason ? `内核拒绝该操作：${reason}` : '内核拒绝该操作，请检查登录状态或配置');
    }
    return data;
  }

  /** 从内核的错误响应体里取出可读原因（{error} 或 {message}，否则原样文本） */
  _errorText(bodyText) {
    const raw = String(bodyText || '').trim();
    if (!raw) return '';
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return String(o.error || o.message || '');
    } catch { /* 非 JSON：按文本处理 */ }
    return raw;
  }

  async _context(pkg, pid) {
    if (typeof pkg !== 'string' || pkg.length > 250 || typeof pid !== 'string' || !PROVIDER_ID_RE.test(pid)) {
      throw new Error('插件或 provider 标识无效');
    }
    const state = await this._api('providers');
    const installed = await this._api('plugins');
    if (!Array.isArray(state?.plugins) || !Array.isArray(state.providers) || !Array.isArray(installed?.plugins)) {
      throw new Error('当前内核不支持插件管理接口');
    }
    const packageOf = (spec) => String(spec || '').replace(/@[^/@]+$/, '');
    const descriptors = state.plugins.filter((p) => packageOf(p.spec) === packageOf(pkg));
    const plugin = descriptors.find((p) => p.pid === pid || p.id === pid);
    const entry = installed.plugins.find((p) => packageOf(p.spec) === packageOf(pkg));
    if (!plugin || !entry) throw new Error('该 provider 不属于所选的已安装插件');
    const row = state.providers.find((p) => p.id === plugin.id);
    return { plugin, descriptors, row, version: typeof entry.version === 'string' ? entry.version : '' };
  }

  _detail({ plugin, descriptors, row, version }) {
    const text = (v) => typeof v === 'string' ? v : '';
    const localized = (v) => this._labels(v);
    const methods = (plugin.methods || []).map((m, index) => ({ index, type: text(m.type),
      label: text(m.label), labels: localized(m.labels), placeholder: text(m.placeholder), keyless: !!m.keyless, keyAsked: !!m.keyAsked }));
    const catalog = Array.isArray(row?.models) ? row.models : Array.isArray(plugin.models) ? plugin.models : [];
    const models = catalog.filter((m) => m && typeof m.id === 'string').map((m) => ({
      id: m.id, name: text(m.name), on: !!m.on, context: typeof m.context === 'number' ? m.context : null,
      output: typeof m.output === 'number' ? m.output : null, images: !!m.images,
    }));
    const chosen = row?.noModels ? [] : Array.isArray(row?.chosen) ? row.chosen : models.filter((m) => m.on).map((m) => m.id);
    return {
      provider: plugin.pid || plugin.id, name: text(plugin.name), spec: text(plugin.spec), version,
      providers: descriptors.map((p) => ({ id: p.pid || p.id, name: text(p.name) })),
      signedIn: !!plugin.signedIn, ready: !!row?.ready, off: !!row?.off,
      methods, models, chosen,
      accounts: (row?.account?.logins || []).map((a) => ({ user: text(a.user), plan: text(a.plan),
        active: !!a.active, on: a.on === undefined ? !!a.active : !!a.on, paused: !!a.paused })),
      options: (plugin.options || []).filter((o) => typeof o.key === 'string').map((o) => ({
        key: o.key, label: text(o.label), labels: localized(o.labels), description: text(o.description),
        descriptions: localized(o.descriptions), on: !!o.on,
      })),
    };
  }

  async detail(pkg, pid) {
    const ctx = await this._context(pkg, pid);
    const detail = this._detail(ctx);
    // 签到不支持时不该让整页失败：内核较早版本没有 quotas 接口。
    detail.checkin = await this._checkin(detail.provider, ctx.row).catch(() => ({ supported: false, accounts: [] }));
    detail.quota = await this._quota(detail.provider).catch(() => ({ available: false, windows: [] }));
    return detail;
  }

  /**
   * 额度：内核 /api/usage/quotas 每行可能带 windows（额度窗口）。
   *
   * 字段语义以内核自身实现为准（magpie 内嵌 app.js）：
   *   `to100(w.used)`            → used 是已用百分比
   *   `quotaCount` 的
   *   `w.amount / w.limit`       → amount/limit 是计数
   * 只取当前 provider 的行；没有 amount+limit 的窗口不编造计数，
   * 仅透传上游的 display 文案。
   */
  async _quota(provider) {
    const quotas = await this._api('usage/quotas');
    if (!Array.isArray(quotas)) return { available: false, windows: [] };
    const row = quotas.find((q) => q && q.provider === provider);
    if (!row) return { available: false, windows: [] };
    const windows = (Array.isArray(row.windows) ? row.windows : []).filter((w) => w && typeof w.name === 'string').map((w) => {
      // 内核语义（app.js `to100(w.used)`、`quotaCount` 用 `w.amount / w.limit`）：
      //   used  = **已用百分比**（0–100）
      //   amount= 已用计数，limit = 总量
      // 把 used 当计数去算 used/limit 会得出完全错误的比例。
      const pctRaw = typeof w.used === 'number' && Number.isFinite(w.used) ? w.used : null;
      const pct = pctRaw !== null ? Math.max(0, Math.min(100, Math.round(pctRaw))) : null;
      const amount = typeof w.amount === 'number' && Number.isFinite(w.amount) ? w.amount : null;
      const limit = typeof w.limit === 'number' && Number.isFinite(w.limit) ? w.limit : null;
      return {
        name: w.name,
        used: pctRaw,
        // 计数用 amount；上游没给 amount 时保留 null，由界面回退到 display
        amount,
        limit,
        // 上游有时只给一句人话（"0 credits left"），原样透传，不当成数值
        display: typeof w.display === 'string' ? w.display : '',
        unit: typeof w.unit === 'string' ? w.unit : '',
        percent: pct,
        // 有 limit 才能画进度条；没有就只显示文字
        resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : '',
      };
    });
    return {
      available: windows.length > 0,
      plan: typeof row.plan === 'string' ? row.plan : '',
      user: typeof row.user === 'string' ? row.user : '',
      readAt: typeof row.readAt === 'string' ? row.readAt : '',
      // 上游错误可能夹带 token/UUID/URL 片段：脱敏后再给前端
      error: typeof row.error === 'string' ? this._redact(row.error) : '',
      windows,
    };
  }

  /**
   * 签到状态：内核把每个账号的签到结果放在 /api/usage/quotas 的行里
   * （checkinBy / checkinKey / checkin{day,outcome,msg}）。
   * 只返回当前插件 provider 对应的账号，不暴露其它 provider 的用量数据。
   */
  async _checkin(provider, row) {
    const quotas = await this._api('usage/quotas');
    if (!Array.isArray(quotas)) return { supported: false, accounts: [] };
    const prefix = 'plugin:' + provider;
    const mine = quotas.filter((q) => q && (q.checkinBy === prefix || q.provider === provider));
    // 必须同时有 checkinBy 与 checkinKey 才能签：只凭 checkins=true 就收，
    // 会造出 key='' 的条目，点下去等于把空 key 下发内核。
    const accounts = mine.filter((q) => q.checkinBy === prefix && typeof q.checkinKey === 'string' && q.checkinKey).map((q) => {
      const c = q.checkin || null;
      return {
        user: typeof q.user === 'string' ? q.user : '',
        key: q.checkinKey,
        by: q.checkinBy,
        day: c && typeof c.day === 'string' ? c.day : '',
        outcome: c && typeof c.outcome === 'string' ? c.outcome : '',
        message: c && typeof c.msg === 'string' ? this._redact(c.msg) : '',
        // 内核的 credit 可能是数字（奖励点数），不能只收 string
        credit: c && (typeof c.credit === 'string' || typeof c.credit === 'number') ? String(c.credit) : '',
        streak: c && typeof c.streak === 'number' ? c.streak : 0,
        // again：上游称今天已签，但内核还要再确认 → 不算完成
        again: !!(c && c.again),
      };
    });
    return {
      supported: accounts.length > 0 || mine.some((q) => q.checkins === true),
      accounts,
      // 只有真正登录了才可签到；未登录时按钮应禁用
      canCheck: !!row && accounts.length > 0,
    };
  }


  _signinState(data) {
    const result = {};
    for (const key of ['id', 'state', 'code', 'opened', 'linkOnly']) {
      if (['string', 'boolean'].includes(typeof data?.[key])) result[key] = data[key];
    }
    if (typeof data?.url === 'string') {
      try {
        const url = new URL(data.url);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) result.url = url.href;
      } catch { /* 非 URL 不作为链接展示 */ }
    }
    if (['failed', 'error'].includes(result.state)) result.message = '登录未完成，请重新尝试或选择其它登录方式';
    return result;
  }

  /**
   * 上游错误文本的脱敏：截断 + 抹掉长串凭据样式的 token/URL 查询参数。
   * 上游的错误体可能包含 Authorization 回显、refresh token 或带密钥的 URL，
   * 直接透传到前端等于把凭据交给渲染进程与 DevTools。
   */
  _redact(text) {
    return String(text || '')
      // 长的不透明串（token / key / JWT / base64）
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[已隐藏]')
      // URL 查询参数里的值
      .replace(/([?&](?:k|key|token|access_token|refresh_token|api_key)=)[^&\s]+/gi, '$1[已隐藏]')
      .slice(0, 200);
  }

  _labels(value) {
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key, text]) => /^[a-z-]{2,12}$/i.test(key) && typeof text === 'string')) : {};
  }

  _prompt(data) {
    const inputs = data?.inputs && typeof data.inputs === 'object' && !Array.isArray(data.inputs) ? data.inputs : undefined;
    if (!data?.prompt) return { inputs: inputs || {} };
    const p = data.prompt;
    return { inputs, prompt: { key: p.key, type: p.type, label: p.label, message: p.message, messages: this._labels(p.messages),
      placeholder: p.placeholder, secret: !!p.secret || p.type === 'password', options: Array.isArray(p.options)
        ? p.options.map((o) => ({ value: o.value, label: o.label, labels: this._labels(o.labels) })) : undefined } };
  }

  async action(pkg, pid, action, body = {}) {
    // 登录轮询只访问已校验归属的会话，不反复拉取整个 provider/插件清单。
    if (action === 'signin-status' || action === 'signin-cancel') {
      const session = this.signins.get(body.id);
      if (!session || session.pkg !== pkg || session.pid !== pid || session.origin !== this._target().origin
        || Date.now() - session.at > 30 * 60 * 1000) throw new Error('登录会话不属于该插件或已过期');
      const endpoint = 'signin/' + encodeURIComponent(body.id) + (action === 'signin-cancel' ? '/cancel' : '');
      const result = this._signinState(await this._api(endpoint, action === 'signin-cancel' ? {} : undefined));
      if (action === 'signin-cancel') this.signins.delete(body.id);
      return result;
    }
    const ctx = await this._context(pkg, pid);
    const { plugin, row } = ctx;
    const provider = plugin.pid || plugin.id;
    const id = plugin.id;
    if (action === 'signin-prompt' || action === 'signin-start') {
      if (!Number.isInteger(body.method) || !plugin.methods?.[body.method]) throw new Error('登录方式无效');
      if (!body.inputs || typeof body.inputs !== 'object' || Array.isArray(body.inputs)
        || JSON.stringify(body.inputs).length > 16384) throw new Error('登录输入无效');
      if (body.user !== undefined && !row?.account?.logins?.some((a) => a.user === body.user)) throw new Error('账号不属于该插件');
      const payload = { provider, method: body.method, inputs: body.inputs };
      if (action === 'signin-prompt') {
        if (body.key !== undefined) {
          if (typeof body.key !== 'string' || typeof body.value !== 'string' || body.value.length > 8192) throw new Error('登录回答无效');
          Object.assign(payload, { key: body.key, value: body.value });
        }
        return this._prompt(await this._api('plugin-signin/prompt', payload));
      }
      if (body.key !== undefined) {
        if (typeof body.key !== 'string' || body.key.length > 16384) throw new Error('登录密钥无效');
        payload.key = body.key;
      }
      if (body.user) payload.user = body.user;
      const result = this._signinState(await this._api('plugin-signin', payload));
      if (result.id) {
        for (const [key, value] of this.signins) if (Date.now() - value.at > 30 * 60 * 1000) this.signins.delete(key);
        this.signins.set(result.id, { pkg, pid, origin: this._target().origin, at: Date.now() });
      }
      return result;
    }
    if (['account-on', 'account-off', 'account-remove'].includes(action)) {
      const account = row?.account?.logins?.find((a) => a.user === body.user);
      if (!account || !row.account.agent) throw new Error('账号不属于该插件');
      const op = { 'account-on': 'on', 'account-off': 'off', 'account-remove': 'forget' }[action];
      await this._api('login/' + op, { agent: row.account.agent, user: account.user });
    } else if (action === 'models-refresh') {
      if (!row) throw new Error('请先登录该插件');
      await this._api('provider/models', { id });
    } else if (action === 'models-save') {
      if (!row || !Array.isArray(body.models) || body.models.length > 2000
        || !body.models.every((m) => typeof m === 'string' && row.models?.some((x) => x.id === m))) throw new Error('模型选择无效');
      // 订阅 provider 的 Save 同时接收高级字段：从最新状态保留它们，不能用前端默认值覆盖。
      const payload = { id };
      // modelPrefs（每个模型的偏好）与 searches（搜索开关）是内核编辑器每次
    // 都会带上的字段：漏掉它们，保存一次模型选择就会把用户这些设置清空。
    for (const key of ['bestInFamily', 'unlisted', 'hiddenDrawers', 'hiddenVideomakers', 'fallback', 'contexts',
        'outputs', 'compacts', 'proxy', 'accountProxies', 'maxConcurrency', 'maxAccounts', 'queueLimit', 'queueWait',
        'maxRPM', 'priceRate', 'rateWindows', 'pinUpstream', 'unredacted', 'countFree', 'billing', 'nativeCompaction',
        'routing', 'affinity', 'sink', 'modelPrefs', 'searches']) {
        if (Object.hasOwn(row, key)) payload[key] = row[key];
      }
      payload.models = [...new Set(body.models)];
      payload.noModels = payload.models.length === 0;
      await this._api('provider/save', payload);
    } else if (action === 'provider-toggle') {
      // 启用/禁用某个 provider：禁用后它不参与路由，账号与配置保留。
      if (typeof body.on !== 'boolean') throw new Error('开关状态无效');
      await this._api('provider/' + (body.on ? 'on' : 'off'), { id });
    } else if (action === 'option-save') {
      if (typeof body.key !== 'string' || typeof body.on !== 'boolean'
        || !plugin.options?.some((o) => o.key === body.key)) throw new Error('插件选项无效');
      await this._api('settings/plugin-option', { provider, key: body.key, on: body.on });
    } else if (action === 'checkin') {
      // 签到按账号执行：key 必须是该 provider 的账号，不接受任意串。
      const state = await this._checkin(provider, row);
      if (!state.supported) throw new Error('该插件没有提供签到功能');
      if (typeof body.key !== 'string' || !state.accounts.some((a) => a.key === body.key)) {
        throw new Error('签到账号不属于该插件');
      }
      const account = state.accounts.find((a) => a.key === body.key);
      await this._api('usage/checkin-account', { by: account.by, key: account.key });
      return this.detail(pkg, pid);
    } else if (action === 'checkin-all') {
      // 一键签到：把该 provider 所有账号依次签一遍。内核按账号提供
      // /usage/checkin-account，没有全量端点，所以在这里顺序执行
      // （插件账号通常个位数，且同一 provider 并发签到容易触发上游风控）。
      //
      // 「成功」必须以签到结果为准，不能只看 HTTP 没报错：
      // 有些账号请求成功但上游根本没给（如 Qoder 需要官方客户端的设备身份，
      // 返回 ineligible）。只按异常判定会把它们误报成签到成功。
      if (!row) throw new Error('请先登录该插件');
      const before = await this._checkin(provider, row);
      if (!before.supported) throw new Error('该插件没有提供签到功能');
      if (!before.accounts.length) throw new Error('该插件还没有登录账号');
      const errors = new Map();
      for (const account of before.accounts) {
        try {
          await this._api('usage/checkin-account', { by: account.by, key: account.key });
        } catch (e) {
          errors.set(account.key, this._redact(e.message));
        }
      }
      // 重新读一次状态：签成功的 outcome 会变成 claimed/done
      const after = await this._checkin(provider, row);
      const results = after.accounts.map((a) => ({
        key: a.key,
        user: a.user,
        ok: !errors.has(a.key) && a.day === todayCN() && (a.outcome === 'claimed' || a.outcome === 'done') && !a.again,
        outcome: a.outcome,
        message: errors.get(a.key) || a.message,
      }));
      const failed = results.filter((r) => !r.ok);
      const detail = await this.detail(pkg, pid);
      return {
        ...detail,
        checkinAll: {
          count: results.length,
          succeeded: results.length - failed.length,
          failed: failed.length,
          // 失败原因带回去，前端不必再猜
          failures: failed.slice(0, 5).map((r) => ({ user: r.user, message: r.message })),
        },
      };
    } else {
      throw new Error('不支持的插件管理操作');
    }
    return this.detail(pkg, pid);
  }
}

module.exports = {
  PluginPanel,
  RoutingGroups,
  magpieConfigDir,
  listProviders,
  listGroups,
  checkViaCli,
  listPluginCatalog,
  addPlugin,
  removePlugin,
  probeLoginMethods,
  startLogin,
  cancelLogin,
  logoutProvider,
  loginState,
  listLoginStates,
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
  installMagpie,
  installProgress,
  MAGPIE_RELEASES_REPO,
};