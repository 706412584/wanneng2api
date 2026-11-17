// Mock 数据层：与 Manager API 响应同形状（docs/DESIGN.md §4.4）
// 模式：VITE_API_MODE=mock（默认）。平台状态周期自动变化以演示。
const BOOT = Date.now()

const MOCK_SETTINGS = {
  general: {
    language: 'zh-CN',
    theme: 'auto',
    closeAction: 'tray',
    autoStart: true,
    startMinimized: true,
    keepAwake: false,
    autoStartPlatforms: ['workbuddy', 'codearts', 'loomy', 'hub'],
    autoStartDelaySec: 0
  },
  manager: { listen: '127.0.0.1:17800', logLevel: 'info' },
  update: { checkOnLaunch: true, channel: 'stable', githubToken: '', keepBackups: 3 },
  proxy: {
    enabled: false,
    url: '',
    scopes: {
      selfUpdate: false, platformUpdate: false, pluginRegistry: false, magpieKernel: false,
      tunnelDownload: false, tunnelRuntime: false, magpieSubscription: false, magpiePlugin: false
    }
  },
  sub2api: { pgPort: 5433, redisPort: 6380, dataDir: '' }
}

function makePlatforms() {
  return [
    {
      id: 'hub', name: 'Hub 聚合层', type: 'go-binary', enabled: true, state: 'healthy',
      pid: 24100, uptimeSec: 86400 + 3600, version: '0.3.1', port: 17810, health: 'ok', lastError: null, updateAvailable: false, installed: true
    },
    {
      id: 'workbuddy', name: 'WorkBuddy2API', type: 'go-binary', enabled: true, state: 'healthy',
      pid: 22108, uptimeSec: 86400 - 1200, version: '1.8.4', port: 7863, health: 'ok', lastError: null, updateAvailable: true, installed: true
    },
    {
      id: 'codearts', name: 'CodeArts2API Panel', type: 'go-binary', enabled: true, state: 'degraded',
      pid: 19456, uptimeSec: 4210, version: '2.1.0', port: 7866, health: 'fail-2', lastError: '健康探活 /v1/models 连续 2 次超时', updateAvailable: true, installed: true
    },
    {
      id: 'loomy', name: 'Loomy2API', type: 'python-module', enabled: true, state: 'starting',
      pid: 31244, uptimeSec: 14, version: '0.9.7', port: 17990, health: 'pending', lastError: null, updateAvailable: false, installed: true
    },
    {
      id: 'sub2api', name: 'Sub2API（可选）', type: 'go-binary', enabled: false, state: 'stopped',
      pid: null, uptimeSec: 0, version: '1.4.2', port: 8080, health: 'off', lastError: null, updateAvailable: false
    }
  ]
}

const platforms = makePlatforms()

// sub2api 依赖三圆点（仅该卡显示）
const sub2apiDeps = { pg: 'stopped', redis: 'stopped', server: 'stopped' }

const healthHistory = {
  workbuddy: [
    { ts: BOOT - 1000 * 60 * 6, event: 'healthy', note: '健康探活通过 /healthz' },
    { ts: BOOT - 1000 * 60 * 42, event: 'restart', note: '进程自动重启（退避 2s）' },
    { ts: BOOT - 1000 * 60 * 90, event: 'healthy', note: '健康探活通过' }
  ],
  codearts: [
    { ts: BOOT - 1000 * 60 * 3, event: 'degraded', note: '/v1/models 连续 2 次超时' },
    { ts: BOOT - 1000 * 60 * 70, event: 'healthy', note: '健康探活通过' }
  ],
  loomy: [
    { ts: BOOT - 1000 * 15, event: 'starting', note: 'python -m loomy2api serve 已拉起' }
  ]
}

const LOG_SAMPLES = {
  hub: [
    'INFO hub: listening on 127.0.0.1:17810',
    'INFO route hit model=claude-sonnet-4 -> workbuddy (ttfb 212ms)',
    'INFO route hit model=deepseek-chat -> loomy (ttfb 340ms)',
    'WARN upstream codearts cooldown 30s (server_error)',
    'INFO usage flush: 128 records -> hub/usage/20261110.jsonl'
  ],
  workbuddy: [
    'INFO workbuddy: server started on :7863',
    'INFO account pool refreshed, 9 accounts active',
    'INFO /v1/chat/completions 200 stream=true 4.2s',
    'WARN account acc-3 rate limited, cooldown 600s',
    'INFO /healthz 200'
  ],
  codearts: [
    'INFO codearts panel: listening :7866',
    'INFO token refresh ok (session valid)',
    'WARN upstream timeout on /v1/models (attempt 1/3)',
    'ERROR upstream timeout on /v1/models (attempt 2/3)',
    'INFO /v1/models 200 41 models'
  ],
  loomy: [
    'INFO loomy2api: module loaded',
    'INFO serve: http on 127.0.0.1:17990',
    'INFO accounts.json loaded (9 entries, .bak x9 preserved)',
    'INFO GET /health 200'
  ],
  sub2api: [
    'INFO sub2api: waiting for pg/redis',
    'INFO pg ready on 127.0.0.1:5433',
    'INFO redis ready on 127.0.0.1:6380'
  ]
}

let reqCounter = 18420
let tokCounter = 38_421_900

const latency = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

// 状态周期演化（mock 演示用）：loomy starting→healthy；codearts degraded↔healthy；hub 稳定
function evolve() {
  const loomy = platforms.find((p) => p.id === 'loomy')
  if (loomy && loomy.state === 'starting') {
    loomy.state = 'healthy'
    loomy.health = 'ok'
    loomy.uptimeSec = Math.max(loomy.uptimeSec, 20)
    pushEvent('loomy', 'healthy', '健康探活通过 /health')
  }
  const codearts = platforms.find((p) => p.id === 'codearts')
  if (codearts) {
    if (codearts.state === 'healthy') {
      codearts.state = 'degraded'
      codearts.health = 'fail-2'
      codearts.lastError = '健康探活 /v1/models 连续 2 次超时'
      pushEvent('codearts', 'degraded', '/v1/models 连续 2 次超时')
    } else if (codearts.state === 'degraded' && Math.random() < 0.4) {
      codearts.state = 'healthy'
      codearts.health = 'ok'
      codearts.lastError = null
      pushEvent('codearts', 'healthy', '健康探活通过')
    }
  }
  for (const p of platforms) {
    if (p.state === 'healthy' || p.state === 'degraded') p.uptimeSec += 5
  }
  reqCounter += Math.floor(Math.random() * 40)
  tokCounter += Math.floor(Math.random() * 90000)
}

function pushEvent(id, event, note) {
  if (!healthHistory[id]) healthHistory[id] = []
  healthHistory[id].unshift({ ts: Date.now(), event, note })
  if (healthHistory[id].length > 30) healthHistory[id].length = 30
}

setInterval(evolve, 5000)

const RECENT_USAGE = Array.from({ length: 20 }, (_, i) => ({
  ts: Date.now() - i * 45000,
  upstream: ['workbuddy', 'codearts', 'loomy'][i % 3],
  model: ['claude-sonnet-4-20250514', 'deepseek-chat', 'gpt-4o-mini'][i % 3],
  status: i === 4 ? 429 : i === 11 ? 502 : 200,
  ttfbMs: 180 + Math.floor(Math.random() * 900),
  latencyMs: 900 + Math.floor(Math.random() * 6000),
  promptTokens: 1200 + Math.floor(Math.random() * 8000),
  completionTokens: 200 + Math.floor(Math.random() * 2400)
}))

const MOCK_PLATFORM_DETAIL = (id) => {
  const p = platforms.find((x) => x.id === id)
  if (!p) throw new Error(`platform not found: ${id}`)
  return {
    ...clone(p),
    mode: id === 'loomy' ? 'import' : 'managed',
    workDir: id === 'loomy' ? 'D:/app/loomy2api' : `%APPDATA%/wanneng2api/platforms/${id}`,
    runCmd: id === 'loomy' ? 'python -m loomy2api serve' : id === 'hub' ? 'hub.exe -c hub.json' : `${id}2api.exe`,
    healthUrl: `http://127.0.0.1:${p.port}${id === 'workbuddy' ? '/healthz' : id === 'codearts' ? '/v1/models' : id === 'loomy' ? '/health' : id === 'sub2api' ? '/api/health' : '/health'}`,
    restartPolicy: { baseBackoffSec: 2, maxBackoffSec: 300, maxRetries: 0 },
    deps: id === 'sub2api' ? clone(sub2apiDeps) : undefined,
    history: clone(healthHistory[id] || [])
  }
}

const UPDATES_SUMMARY = () => ({
  checkedAt: Date.now() - 1000 * 60 * 12,
  items: platforms.map((p) => ({
    id: p.id,
    name: p.name,
    current: p.version,
    latest: p.updateAvailable ? nextVersion(p.version) : p.version,
    updateAvailable: p.updateAvailable,
    hasUpdater: p.id !== 'hub',
    state: p.state === 'updating' ? 'updating' : p.updateAvailable ? 'available' : 'up-to-date',
    notes: p.updateAvailable ? '修复上游协议变更；账号池冷却策略优化；建议尽快更新。' : ''
  }))
})

function nextVersion(v) {
  const parts = v.split('.').map(Number)
  parts[parts.length - 1] += 1
  return parts.join('.')
}

const MOCK_TUNNELS = [
  { id: 'workbuddy', name: 'WorkBuddy2API', kind: 'api', mode: 'quick', autoStart: true, phase: 'running', stage: 'idle', publicUrl: 'https://demo-workbuddy.trycloudflare.com', configuredPublicUrl: '', guardUrl: 'http://127.0.0.1:17901', upstreamPort: 7863, pid: 45601, localHealth: 'ok', publicHealth: 'ok', desiredRunning: true, hasToken: false },
  { id: 'codearts', name: 'CodeArts2API', kind: 'api', mode: 'named', autoStart: false, phase: 'stopped', stage: 'idle', publicUrl: '', configuredPublicUrl: 'https://codearts.example.com', guardUrl: 'http://127.0.0.1:17902', upstreamPort: 7866, pid: 0, localHealth: 'unknown', publicHealth: 'unknown', desiredRunning: false, hasToken: true, verifiedAt: 1763260000000, tunnelId: 'demo-codearts-tunnel' },
  { id: 'loomy', name: 'Loomy2API', kind: 'api', mode: 'quick', autoStart: false, phase: 'stopped', stage: 'idle', publicUrl: '', configuredPublicUrl: '', guardUrl: 'http://127.0.0.1:17903', upstreamPort: 17990, pid: 0, localHealth: 'unknown', publicHealth: 'unknown', desiredRunning: false, hasToken: false },
  { id: 'lingxi', name: 'Lingxi2API', kind: 'api', mode: 'quick', autoStart: false, phase: 'stopped', stage: 'idle', publicUrl: '', configuredPublicUrl: '', guardUrl: 'http://127.0.0.1:17904', upstreamPort: 6789, pid: 0, localHealth: 'unknown', publicHealth: 'unknown', desiredRunning: false, hasToken: false },
  { id: 'magpie', name: 'Magpie 统一 API', kind: 'api', mode: 'quick', autoStart: false, phase: 'stopped', stage: 'idle', publicUrl: '', configuredPublicUrl: '', guardUrl: 'http://127.0.0.1:17905', upstreamPort: 3425, pid: 0, localHealth: 'unknown', publicHealth: 'unknown', desiredRunning: false, hasToken: false },
  { id: 'manager', name: 'Wanneng2API 管理台', kind: 'manager', mode: 'named', autoStart: false, phase: 'stopped', stage: 'idle', publicUrl: '', configuredPublicUrl: 'https://manager.example.com', guardUrl: 'http://127.0.0.1:17906', upstreamPort: 17800, pid: 0, localHealth: 'unknown', publicHealth: 'unknown', desiredRunning: false, hasToken: true, verifiedAt: 1763260000000, tunnelId: 'demo-manager-tunnel', passwordConfigured: true },
]
const MOCK_BINARY = { version: '2026.10.6', installed: true, verified: true, downloading: false, received: 0, total: null, error: '' }
const MOCK_ROUTING_GROUPS = [
  { id: 'auto-demo', name: '自动共享组', auto: true, routing: '', members: ['workbuddy/glm', 'codearts/glm'], memberInfo: [] },
  { id: 'custom-demo', name: '自定义入口', auto: false, routing: 'order', members: ['loomy/deepseek'], memberInfo: [] },
]
const MOCK_GATEWAY_KEYS = [
  {
    id: 'ff4234dcbcf5d93051e8c3aa', name: 'Magpie', off: true, readOnly: false, browser: false, expires: '',
    models: ['wanneng-lingxi/*'],
    limit: { period: 'day', tokens: 100000000, cacheReads: true },
    more: [],
    used: { period: 'day', start: '2026-11-16T00:00:00+08:00', reset: '2026-11-17T00:00:00+08:00', calls: 709, tokens: 100147421, tokenLimit: 100000000, tokensLeft: 0, spent: true, cacheReads: true },
    usedAll: [],
  },
  {
    id: 'b22871a44333bafd5dd042c1', name: '豆包', off: false, readOnly: false, browser: false, expires: '',
    models: ['doubao-work/*'], limit: null, more: [], used: null, usedAll: [],
  },
]

const MOCK_ALIAS_STATE = {
  available: true,
  targets: [{
    id: 'key-public', name: '公网专用', eligible: true, reason: '', disabledBySync: false,
    aliases: { used: 11, managed: 11, limit: 200 }, models: { used: 11, managed: 11, limit: 500 },
    lastSuccessAt: BOOT, lastError: '', conflicts: [],
  }],
  keys: [
    { id: 'key-public', name: '公网专用', off: false, eligible: true, reason: '', accountsRestricted: false, isTarget: true },
    { id: 'key-browser', name: '浏览器扩展', off: false, eligible: false, reason: '浏览器扩展专用 Key 不能作为同步目标', accountsRestricted: false, isTarget: false },
  ],
  providers: [
    { id: 'wanneng-lingxi', name: '灵犀', source: 'self-hosted', off: false, ready: true, authorized: true, modelCount: 11, modelCountKnown: true, credential: 'config', lastSuccessAt: BOOT, error: '' },
    { id: 'trae-cn', name: 'Trae CN', source: 'community', off: false, ready: true, authorized: false, modelCount: 24, modelCountKnown: true, credential: 'magpie', lastSuccessAt: 0, error: '' },
    { id: 'local-relay', name: '本地转发', source: 'local', off: false, ready: true, authorized: false, modelCount: 2, modelCountKnown: true, credential: 'magpie', lastSuccessAt: 0, error: '' },
  ],
  authorizedCount: 1,
  usage: { aliases: { used: 11, managed: 11, limit: 200 }, models: { used: 11, managed: 11, limit: 500 } },
  conflicts: [{ code: 'group-required', message: '裸名 glm 跨多个 provider，但没有对应路由组', model: 'glm', providerIds: ['wanneng-lingxi', 'trae-cn'] }],
  disabledBySync: false, lastSuccessAt: BOOT, lastError: '',
  status: { phase: 'idle', revision: 1, pending: false, lastStartedAt: 0, lastFinishedAt: 0, lastError: '' },
}

const MOCK_PLUGINS = [
  { name: 'Trae（演示）', package: '@magpie-community/opencode-trae-auth', kind: 'provider', providers: ['trae'], summary: { zh: '演示插件，用于预览安装、筛选和卡片布局。' }, installed: false, signedIn: false },
  { name: 'Qoder（演示）', package: '@magpie-community/opencode-qoder-auth', kind: 'provider', providers: ['qoder'], summary: { zh: '演示已安装的平台插件。' }, installed: true, signedIn: false },
  { name: '提示词改写（演示）', package: '@demo/prompt-guard', kind: 'middleware', providers: [], summary: { zh: '演示中间件，不连接真实插件仓库。' }, installed: false, signedIn: false },
]

export const mockApi = {
  platformInstallStatus: async (id) => ({ id, status: platforms.find((p) => p.id === id)?.installed ? 'installed' : 'not-installed' }),
  installPlatform: async (id) => ({ id, started: false, installed: true, status: 'installed' }),
  registerPlatformProvider: async () => ({ ok: true }),
  shellUpdateStatus: async () => ({ supported: false, reason: '开发预览不连接桌面壳更新' }),
  checkShellUpdate: async () => ({ supported: false, reason: '开发预览不连接桌面壳更新' }),
  downloadShellUpdate: async () => ({ supported: false }),
  installShellUpdate: async () => ({ supported: false }),
  magpieVersion: async () => ({ current: '0.1.0', latest: '0.1.0', hasUpdate: false, binary: 'demo/magpie', checkedAt: Date.now(), updating: false }),
  magpieInstallStatus: async () => ({ installed: true, binary: 'demo/magpie', progress: null }),

  async magpiePlugins() {
    await latency(80)
    const kinds = {}
    for (const plugin of MOCK_PLUGINS) kinds[plugin.kind] = (kinds[plugin.kind] || 0) + 1
    return { plugins: clone(MOCK_PLUGINS), kinds }
  },

  async magpieAddPlugin(pkg) {
    await latency(160)
    const plugin = MOCK_PLUGINS.find((item) => item.package === pkg)
    if (!plugin) throw new Error('演示插件不存在')
    plugin.installed = true
    return { ok: true }
  },

  async magpieRemovePlugin(pkg) {
    await latency(160)
    const plugin = MOCK_PLUGINS.find((item) => item.package === pkg)
    if (!plugin) throw new Error('演示插件不存在')
    plugin.installed = false
    plugin.signedIn = false
    return { ok: true }
  },

  async magpiePluginPanel(pkg, provider) {
    const plugin = MOCK_PLUGINS.find((item) => item.package === pkg)
    if (!plugin?.installed) throw new Error('请先安装演示插件')
    return { name: plugin.name, provider, accounts: [], methods: [], chosen: [], models: [], options: [] }
  },

  async magpieProviders() {
    return { providers: [], pluginCount: 0, officialCount: 0, configDir: '演示数据' }
  },

  async magpiePresets() {
    return { presets: [], groups: [] }
  },

  async gatewayPanel(id) {
    const platform = platforms.find((p) => p.id === id)
    if (!platform) throw new Error('演示平台不存在')
    return { id, name: platform.name, port: platform.port, capabilities: ['accounts', 'logs'], accounts: { accounts: [] } }
  },

  async gatewayLogs(id) {
    return { id, lines: clone(LOG_SAMPLES[id] || []) }
  },

  async magpieGateway(what) {
    if (what === 'overview') return { version: 'demo', models: 0, apis: ['/v1/chat/completions', '/v1/messages'] }
    if (what === 'usage') return { calls: reqCounter, errors: 0, input: tokCounter, output: 0, cost: 0, retried: 0, series: [] }
    if (what === 'requests') return { rows: [] }
    if (what === 'quotas') return { data: [] }
    if (what === 'mcp') return { servers: [] }
    return {}
  },

  async modelCatalog() {
    return { models: [], warnings: [] }
  },

  async getOverview() {
    await latency(120)
    const running = platforms.filter((p) => ['healthy', 'degraded', 'starting'].includes(p.state)).length
    const alerts = platforms.filter((p) => p.state === 'degraded' || p.state === 'unhealthy' || p.lastError)
    return {
      platforms: platforms.map((p) => ({ id: p.id, state: p.state, healthy: p.state === 'healthy', uptimeSec: p.uptimeSec })),
      hub: { state: platforms.find((p) => p.id === 'hub').state },
      todayRequests: reqCounter,
      todayTokens: tokCounter,
      alerts: alerts.map((p) => ({ id: p.id, level: p.state === 'unhealthy' ? 'error' : 'warn', message: p.lastError || `平台 ${p.name} 处于 ${p.state} 状态` })),
      pendingUpdates: platforms.filter((p) => p.updateAvailable).length
    }
  },

  async listPlatforms() {
    await latency(100)
    return clone(platforms)
  },

  async getPlatformDetail(id) {
    await latency(80)
    return MOCK_PLATFORM_DETAIL(id)
  },

  async platformAction(id, action) {
    await latency(220)
    const p = platforms.find((x) => x.id === id)
    if (!p) throw new Error(`platform not found: ${id}`)
    switch (action) {
      case 'start':
      case 'restart':
        p.enabled = true
        p.state = 'starting'
        p.health = 'pending'
        p.pid = p.pid || 10000 + Math.floor(Math.random() * 50000)
        p.uptimeSec = 0
        p.lastError = null
        if (id === 'sub2api') { sub2apiDeps.pg = 'starting'; sub2apiDeps.redis = 'starting'; sub2apiDeps.server = 'starting' }
        pushEvent(id, 'starting', action === 'restart' ? '用户触发重启' : '用户触发启动')
        setTimeout(() => {
          if (p.state === 'starting') {
            p.state = 'healthy'
            p.health = 'ok'
            if (id === 'sub2api') { sub2apiDeps.pg = 'healthy'; sub2apiDeps.redis = 'healthy'; sub2apiDeps.server = 'healthy' }
            pushEvent(id, 'healthy', '健康探活通过')
          }
        }, 3500)
        break
      case 'stop':
        p.state = 'stopped'
        p.health = 'off'
        p.pid = null
        p.uptimeSec = 0
        if (id === 'sub2api') { sub2apiDeps.pg = 'stopped'; sub2apiDeps.redis = 'stopped'; sub2apiDeps.server = 'stopped' }
        pushEvent(id, 'stopped', '用户触发停止')
        break
      case 'enable':
        p.enabled = true
        pushEvent(id, 'enable', '平台已启用')
        break
      case 'disable':
        p.enabled = false
        p.state = 'stopped'
        p.health = 'off'
        p.pid = null
        p.uptimeSec = 0
        if (id === 'sub2api') { sub2apiDeps.pg = 'stopped'; sub2apiDeps.redis = 'stopped'; sub2apiDeps.server = 'stopped' }
        pushEvent(id, 'disable', '平台已禁用')
        break
      default:
        throw new Error(`unknown action: ${action}`)
    }
    return { ok: true }
  },

  async getLogs(id, tail = 200) {
    await latency(90)
    const pool = LOG_SAMPLES[id] || LOG_SAMPLES.hub
    const lines = []
    let t = Date.now() - tail * 2000
    for (let i = 0; i < Math.min(tail, 60); i++) {
      lines.push({ ts: t, text: pool[i % pool.length] })
      t += 2000
    }
    return { id, lines }
  },

  async checkUpdate(id) {
    await latency(600)
    const p = platforms.find((x) => x.id === id)
    if (!p) throw new Error(`platform not found: ${id}`)
    const has = id !== 'hub' // mock：hub 永远最新，其余有新版
    p.updateAvailable = has
    return {
      current: p.version,
      latest: has ? nextVersion(p.version) : p.version,
      assetUrl: has ? `https://github.com/Patrick130306/${id}2api/releases/download/v${nextVersion(p.version)}/${id}-windows-amd64.exe` : '',
      notes: has ? '修复上游协议变更；账号池冷却策略优化；建议尽快更新。' : '已是最新版本'
    }
  },

  async applyUpdate(id) {
    await latency(200)
    const p = platforms.find((x) => x.id === id)
    if (!p) throw new Error(`platform not found: ${id}`)
    p.state = 'updating'
    pushEvent(id, 'updating', `开始更新 → v${nextVersion(p.version)}`)
    setTimeout(() => {
      if (p.state === 'updating') {
        p.version = nextVersion(p.version)
        p.updateAvailable = false
        p.state = 'healthy'
        p.health = 'ok'
        p.uptimeSec = 0
        pushEvent(id, 'healthy', `更新完成，当前 v${p.version}`)
      }
    }, 8000)
    return { ok: true }
  },

  async openPanel(id) {
    await latency(100)
    const p = platforms.find((x) => x.id === id)
    if (!p) throw new Error(`platform not found: ${id}`)
    return { ok: true, url: `http://127.0.0.1:${p.port}/` }
  },

  async updatesSummary() {
    await latency(140)
    return UPDATES_SUMMARY()
  },

  async hubStatus() {
    await latency(120)
    return {
      state: platforms.find((p) => p.id === 'hub').state,
      baseUrl: 'http://127.0.0.1:17810',
      apiKey: 'sk-wanneng-3f8a2c91b7d64e05a1c2',
      adminKey: 'admin-77c2e9a4',
      listen: '127.0.0.1:17810',
      modelRoutes: [
        { pattern: 'claude-*', chain: ['workbuddy', 'codearts'] },
        { pattern: 'deepseek-*', chain: ['loomy'] },
        { pattern: '*', chain: ['workbuddy', 'codearts', 'loomy'] }
      ],
      upstreams: platforms
        .filter((p) => ['workbuddy', 'codearts', 'loomy', 'sub2api'].includes(p.id))
        .map((p, i) => ({
          id: p.id,
          baseUrl: `http://127.0.0.1:${p.port}`,
          enabled: p.enabled,
          priority: i + 1,
          state: p.state,
          healthy: p.state === 'healthy',
          cooldownSec: p.state === 'degraded' && p.id === 'codearts' ? 300 : 0
        })),
      usage: RECENT_USAGE.map((u) => ({ ...u, ts: Date.now() - Math.floor(Math.random() * 5) * 45000 }))
    }
  },

  async hubReload() {
    await latency(400)
    pushEvent('hub', 'reload', '热重载 hub.json 成功')
    return { ok: true, reloadedAt: Date.now() }
  },

  async routingGroups() {
    return {
      groups: clone(MOCK_ROUTING_GROUPS),
      bindable: [
        { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'glm' }] },
        { id: 'codearts', name: 'CodeArts', models: [{ id: 'glm' }] },
        { id: 'loomy', name: 'Loomy', models: [{ id: 'deepseek' }] },
      ],
    }
  },

  async reorderRoutingGroup(id, members) {
    const group = MOCK_ROUTING_GROUPS.find((item) => item.id === id)
    if (!group) throw new Error('路由组不存在')
    group.members = members
    group.auto = false
    return { groups: clone(MOCK_ROUTING_GROUPS) }
  },

  async bindRoutingGroup({ name, providers }) {
    const id = `group-${Date.now()}`
    const members = providers.map((provider) => `${provider}/model`)
    MOCK_ROUTING_GROUPS.push({ id, name, auto: false, routing: 'order', members, memberInfo: [] })
    return { saved: { id, name, members }, groups: clone(MOCK_ROUTING_GROUPS) }
  },

  async deleteRoutingGroup(id) {
    const group = MOCK_ROUTING_GROUPS.find((item) => item.id === id)
    if (!group) throw new Error('路由组不存在')
    if (group.auto) throw new Error('自动合并的分组不能删除')
    MOCK_ROUTING_GROUPS.splice(MOCK_ROUTING_GROUPS.indexOf(group), 1)
    return { groups: clone(MOCK_ROUTING_GROUPS) }
  },

  async magpieGatewayKeys() {
    await latency(60)
    return { keys: clone(MOCK_GATEWAY_KEYS) }
  },

  async magpieSetGatewayKeyLimit(keyId, limit) {
    await latency(100)
    const target = MOCK_GATEWAY_KEYS.find((k) => k.id === keyId)
    if (!target) throw new Error('Key 不存在')
    if (!Number(limit?.tokens) && !Number(limit?.cost)) throw new Error('Token 上限与费用上限至少填一个')
    target.limit = {
      period: limit.period,
      days: limit.period === 'days' ? Number(limit.days) : undefined,
      hours: limit.period === 'hours' ? Number(limit.hours) : undefined,
      tokens: Number(limit.tokens) || 0,
      cost: Number(limit.cost) || 0,
      cacheReads: !!limit.cacheReads,
      models: Array.isArray(limit.models) ? limit.models : [],
    }
    target.used = { ...(target.used || {}), period: limit.period, tokens: 0, cost: 0, spent: false }
    return { keys: clone(MOCK_GATEWAY_KEYS) }
  },

  async magpieResetGatewayKeyLimit(keyId) {
    await latency(100)
    const target = MOCK_GATEWAY_KEYS.find((k) => k.id === keyId)
    if (!target) throw new Error('Key 不存在')
    if (target.used) target.used = { ...target.used, tokens: 0, cost: 0, tokensLeft: target.limit?.tokens || 0, spent: false }
    return { keys: clone(MOCK_GATEWAY_KEYS) }
  },

  async magpieAliasSync() {
    await latency(60)
    return clone(MOCK_ALIAS_STATE)
  },

  async magpieAliasAction(action, body = {}) {
    await latency(120)
    if (action === 'target-add' || action === 'target-remove') {
      const target = MOCK_ALIAS_STATE.keys.find((item) => item.id === body.keyId && item.eligible)
      if (action === 'target-add' && !target) throw new Error('目标 Key 不可用')
      const active = action === 'target-add'
      const existing = MOCK_ALIAS_STATE.keys.find((item) => item.id === body.keyId)
      if (existing) existing.isTarget = active
      if (active && !MOCK_ALIAS_STATE.targets.some((item) => item.id === body.keyId)) {
        MOCK_ALIAS_STATE.targets.push({
          id: existing.id, name: existing.name, eligible: true, reason: '', disabledBySync: false,
          aliases: { used: 0, managed: 0, limit: 200 }, models: { used: 0, managed: 0, limit: 500 },
          lastSuccessAt: 0, lastError: '', conflicts: [],
        })
      } else {
        MOCK_ALIAS_STATE.targets = MOCK_ALIAS_STATE.targets.filter((item) => item.id !== body.keyId)
      }
      return { ok: true, targetKeyIds: MOCK_ALIAS_STATE.targets.map((item) => item.id) }
    }
    if (action === 'select-key') {
      const selected = MOCK_ALIAS_STATE.keys.find((item) => item.id === body.keyId && item.eligible)
      if (!selected) throw new Error('目标 Key 不可用')
      MOCK_ALIAS_STATE.keys.forEach((item) => { item.isTarget = item.id === selected.id })
      return { ok: true, selectedKeyId: selected.id }
    }
    if (action === 'provider-set') {
      const provider = MOCK_ALIAS_STATE.providers.find((item) => item.id === body.providerId)
      if (!provider) throw new Error('provider 不存在')
      provider.authorized = !!body.authorized
      MOCK_ALIAS_STATE.authorizedCount = MOCK_ALIAS_STATE.providers.filter((item) => item.authorized).length
    } else if (action !== 'sync') throw new Error('不支持的 aliases 同步操作')
    MOCK_ALIAS_STATE.status.phase = 'syncing'
    MOCK_ALIAS_STATE.status.pending = true
    MOCK_ALIAS_STATE.status.revision += 1
    const revision = MOCK_ALIAS_STATE.status.revision
    setTimeout(() => {
      const models = MOCK_ALIAS_STATE.providers.filter((item) => item.authorized)
        .reduce((total, item) => total + (item.modelCount || 0), 0)
      MOCK_ALIAS_STATE.usage.aliases.used = models
      MOCK_ALIAS_STATE.usage.aliases.managed = models
      MOCK_ALIAS_STATE.usage.models.used = models
      MOCK_ALIAS_STATE.usage.models.managed = models
      MOCK_ALIAS_STATE.status.phase = 'idle'
      MOCK_ALIAS_STATE.status.pending = false
      MOCK_ALIAS_STATE.lastSuccessAt = Date.now()
    }, 700)
    return { ok: true, revision, status: 'syncing' }
  },

  async tunnels() {
    await latency(80)
    return { targets: clone(MOCK_TUNNELS), binary: clone(MOCK_BINARY) }
  },

  async tunnelBinaryStatus() { return clone(MOCK_BINARY) },

  async installTunnelBinary() {
    MOCK_BINARY.downloading = true
    setTimeout(() => { MOCK_BINARY.downloading = false; MOCK_BINARY.installed = true; MOCK_BINARY.verified = true }, 800)
    return { started: true, status: clone(MOCK_BINARY) }
  },

  async saveTunnelConfig(id, patch) {
    const target = MOCK_TUNNELS.find((item) => item.id === id)
    if (!target) throw new Error('未知外网目标')
    for (const key of ['mode', 'autoStart', 'guardPort']) if (patch[key] !== undefined) target[key] = patch[key]
    if (patch.publicUrl !== undefined) target.configuredPublicUrl = patch.publicUrl
    if (patch.token !== undefined) {
      target.hasToken = patch.token !== ''
      target.verifiedAt = 0
      target.tunnelId = ''
    }
    target.updatedAt = Date.now()
    return clone(target)
  },

  async verifyTunnelToken(id, token) {
    await latency(250)
    if (token === 'invalid') {
      const error = new Error('Cloudflare 拒绝了此 Tunnel Token')
      error.code = 'TOKEN_REFUSED'
      throw error
    }
    const target = MOCK_TUNNELS.find((item) => item.id === id)
    if (!target) throw new Error('未知外网目标')
    if (token || target.hasToken) {
      target.hasToken = true
      target.verifiedAt = Date.now()
      target.tunnelId = `demo-${id}-tunnel`
    }
    return { ok: true, verifiedAt: target.verifiedAt, tunnelId: target.tunnelId }
  },

  async preflightTunnel(id) {
    await latency(180)
    return { ok: true, id, keyVerified: true, localHealth: 'ok', targetStatus: 200 }
  },

  async startTunnel(id) {
    const target = MOCK_TUNNELS.find((item) => item.id === id)
    if (!target) throw new Error('未知外网目标')
    target.phase = 'starting'
    target.stage = 'registering'
    target.desiredRunning = true
    setTimeout(() => {
      target.phase = 'running'
      target.stage = 'idle'
      target.pid = 45000 + MOCK_TUNNELS.indexOf(target)
      target.localHealth = 'ok'
      target.publicHealth = 'ok'
      target.publicUrl = target.mode === 'quick' ? `https://demo-${id}.trycloudflare.com` : target.configuredPublicUrl
    }, 700)
    return { ...clone(target), started: true }
  },

  async stopTunnel(id) {
    const target = MOCK_TUNNELS.find((item) => item.id === id)
    if (!target) throw new Error('未知外网目标')
    target.phase = 'stopped'
    target.stage = 'idle'
    target.desiredRunning = false
    target.pid = 0
    target.publicUrl = ''
    return clone(target)
  },

  async tunnelLogs(id) {
    return { id, lines: [`INFO ${id} 隧道状态已刷新`, 'INFO 日志中的 Token、Key 与 Cookie 均已脱敏'] }
  },

  async setTunnelManagerPassword() {
    const target = MOCK_TUNNELS.find((item) => item.id === 'manager')
    target.passwordConfigured = true
    return { configured: true, updatedAt: Date.now() }
  },

  async getSettings() {
    await latency(110)
    return clone(MOCK_SETTINGS)
  },

  async putSettings(settings) {
    await latency(240)
    Object.assign(MOCK_SETTINGS.general, settings.general || {})
    Object.assign(MOCK_SETTINGS.manager, settings.manager || {})
    Object.assign(MOCK_SETTINGS.update, settings.update || {})
    Object.assign(MOCK_SETTINGS.sub2api, settings.sub2api || {})
    if (settings.proxy) {
      Object.assign(MOCK_SETTINGS.proxy, settings.proxy)
      Object.assign(MOCK_SETTINGS.proxy.scopes, settings.proxy.scopes || {})
    }
    return { ok: true }
  }
}

/**
 * 模拟 SSE 日志流：每 1.2s 从样本池随机推一行（mock 模式）
 * @returns {() => void} 取消函数
 */
export function mockLogStream(ids, onLine) {
  let alive = true
  const tick = () => {
    if (!alive || !ids.length) return
    const id = ids[Math.floor(Math.random() * ids.length)]
    const pool = LOG_SAMPLES[id] || LOG_SAMPLES.hub
    const text = pool[Math.floor(Math.random() * pool.length)]
    onLine({ id, text })
  }
  const timer = setInterval(tick, 1200)
  // 立即各推一行，避免等待感
  setTimeout(() => { if (alive) ids.forEach((id) => {
    const pool = LOG_SAMPLES[id] || LOG_SAMPLES.hub
    onLine({ id, text: pool[0] })
  }) }, 60)
  return () => { alive = false; clearInterval(timer) }
}
