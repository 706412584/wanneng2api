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
    autoStartPlatforms: ['workbuddy', 'codearts', 'loomy', 'hub'],
    autoStartDelaySec: 0
  },
  manager: { listen: '127.0.0.1:17800', logLevel: 'info' },
  update: { checkOnLaunch: true, channel: 'stable', githubToken: '', keepBackups: 3 },
  sub2api: { pgPort: 5433, redisPort: 6380, dataDir: '' }
}

function makePlatforms() {
  return [
    {
      id: 'hub', name: 'Hub 聚合层', type: 'go-binary', enabled: true, state: 'healthy',
      pid: 24100, uptimeSec: 86400 + 3600, version: '0.3.1', port: 17810, health: 'ok', lastError: null, updateAvailable: false
    },
    {
      id: 'workbuddy', name: 'WorkBuddy2API', type: 'go-binary', enabled: true, state: 'healthy',
      pid: 22108, uptimeSec: 86400 - 1200, version: '1.8.4', port: 7863, health: 'ok', lastError: null, updateAvailable: true
    },
    {
      id: 'codearts', name: 'CodeArts2API Panel', type: 'go-binary', enabled: true, state: 'degraded',
      pid: 19456, uptimeSec: 4210, version: '2.1.0', port: 7866, health: 'fail-2', lastError: '健康探活 /v1/models 连续 2 次超时', updateAvailable: true
    },
    {
      id: 'loomy', name: 'Loomy2API', type: 'python-module', enabled: true, state: 'starting',
      pid: 31244, uptimeSec: 14, version: '0.9.7', port: 17990, health: 'pending', lastError: null, updateAvailable: false
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
    state: p.state === 'updating' ? 'updating' : p.updateAvailable ? 'available' : 'up-to-date',
    notes: p.updateAvailable ? '修复上游协议变更；账号池冷却策略优化；建议尽快更新。' : ''
  }))
})

function nextVersion(v) {
  const parts = v.split('.').map(Number)
  parts[parts.length - 1] += 1
  return parts.join('.')
}

export const mockApi = {
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
