// Manager API 客户端 —— 端点形状严格按 docs/DESIGN.md §4.4
// 基址 http://127.0.0.1:17800（壳子主进程内嵌，仅 127.0.0.1）
import { mockApi, mockLogStream } from './mock'

// 生产构建（npm run build）默认连真实壳；开发服务器默认 mock。
// 之前构建产物落到 mock，打包后打开就是假数据，和桌面版应有的行为相反。
const MODE = (import.meta.env.VITE_API_MODE
  || (import.meta.env.PROD ? 'live' : 'mock')).toLowerCase()
const DEFAULT_BASE = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
  ? window.location.origin
  : 'http://127.0.0.1:17800'
const BASE = (import.meta.env.VITE_API_BASE || DEFAULT_BASE).replace(/\/$/, '')
const TIMEOUT_MS = 8000

function remoteCsrf() {
  if (typeof document === 'undefined') return ''
  const item = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('__Host-wanneng_csrf='))
  return item ? item.slice('__Host-wanneng_csrf='.length) : ''
}

export const isMock = MODE === 'mock'

/**
 * 统一 fetch 封装：超时 + 非 2xx 抛错 + JSON 解析
 * @param {string} path 以 / 开头的 API 路径
 * @param {{method?: string, body?: any, timeout?: number}} opts
 */
async function request(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  const csrf = remoteCsrf()
  try {
    const res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      // X-Wanneng-Client：壳用 file:// 回退加载 UI 时 Origin 是 null，
// 与「任意网页的 sandbox iframe」无法区分。带这个自定义头证明是本台 UI
// （跨站写请求无法设置它，会先触发预检并被拒绝）。
      headers: {
        'X-Wanneng-Client': 'wanneng2api',
        ...(csrf ? { 'X-Wanneng-CSRF': csrf } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      // 壳的错误体统一是 {"error":"..."}。直接抛出会把 JSON 括号和转义
      // 一起显示在界面上（还会叠加 own 的状态码，看起来像两个不同的错误），
      // 所以这里把可读的那条抽出来，其余情况才退回原始片段。
      let reason = ''
      try {
        const parsed = JSON.parse(detail)
        if (parsed && typeof parsed === 'object') reason = parsed.error || parsed.message || ''
      } catch { /* 非 JSON */ }
      const shown = String(reason || detail || '').slice(0, 300)
      throw new Error(`HTTP ${res.status}${shown ? `: ${shown}` : ''}`)
    }
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

/** 探活：Manager API 是否可达（带短超时；mock 模式视为始终在线） */
export async function pingManager() {
  if (isMock) return true
  try {
    await request('/api/overview', { timeout: 2500 })
    return true
  } catch {
    return false
  }
}

// ---------- 形状适配 ----------
// 壳的真实响应与 UI 组件的期望有两处差异，统一在这里抹平，
// 这样 UI 组件本身不必关心数据来自 mock 还是壳：
//   1. 壳用 `status` 表示平台状态，UI 用 `state`
//   2. 壳把列表包在对象里（{platforms}/{updates}），UI 期望直接是数组
const stateOf = (p) => p.state ?? p.status

function adaptPlatform(p) {
  if (!p || typeof p !== 'object') return p
  return {
    ...p,
    state: stateOf(p),
    // 空账号池：进程正常，只是在等用户加账号（壳回 emptyAccounts）。
    health: p.health ?? (stateOf(p) === 'healthy'
      ? (p.emptyAccounts ? 'empty' : 'ok')
      : 'unknown'),
    uptimeSec: p.uptimeSec ?? 0,
    updateAvailable: p.updateAvailable ?? p.hasUpdate ?? false
  }
}

function adaptPlatformList(r) {
  const arr = Array.isArray(r) ? r : (Array.isArray(r?.platforms) ? r.platforms : [])
  return arr.map(adaptPlatform)
}

// ---------- 平台 ----------
export const api = new Proxy({
  getOverview: async () => {
    const d = await request('/api/overview')
    const platforms = adaptPlatformList(d)
    // 壳返回的 alerts 是数字（告警条数），不是数组；UI 需要明细列表。
    // 口径必须与后端一致：只算 unhealthy / error，不把 lastError 也算进去
    // （error 态的平台本身已计入，再按 lastError 数一次会重复）。
    const alerts = Array.isArray(d.alerts)
      ? d.alerts
      : platforms
        .filter((p) => p.state === 'unhealthy' || p.state === 'error')
        .map((p) => ({ id: p.id, level: p.state === 'error' ? 'error' : 'warn', message: p.lastError || `平台处于 ${p.state} 状态` }))
    return {
      ...d,
      platforms,
      hub: d.hub ? { ...d.hub, state: stateOf(d.hub) } : null,
      alerts,
      pendingUpdates: d.pendingUpdates ?? platforms.filter((p) => p.updateAvailable).length
    }
  },

  listPlatforms: async () => adaptPlatformList(await request('/api/platforms')),

  getPlatformDetail: async (id) => {
    const d = await request(`/api/platforms/${encodeURIComponent(id)}/detail`)
    return d && typeof d === 'object' ? adaptPlatform(d) : d
  },

  platformAction: (id, action, opts) => request(
    `/api/platforms/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', body: opts || undefined, timeout: 180000 },
  ),
  getLogs: (id, tail = 200) => request(`/api/platforms/${encodeURIComponent(id)}/logs?tail=${tail}`),
  installPlatform: (id) => request(`/api/platforms/${encodeURIComponent(id)}/install`, { method: 'POST', timeout: 30000 }),
  platformInstallStatus: (id) => request(`/api/platforms/${encodeURIComponent(id)}/install`),
  registerPlatformProvider: (id) => request(`/api/platforms/${encodeURIComponent(id)}/register-provider`, { method: 'POST', timeout: 180000 }),

  checkUpdate: (id) => request(`/api/platforms/${encodeURIComponent(id)}/update/check`, { method: 'POST' }),
  applyUpdate: (id, checkInfo) => request(`/api/platforms/${encodeURIComponent(id)}/update/apply`, { method: 'POST', body: checkInfo ? { checkInfo } : undefined }),
  openPanel: async (id, query) => {
    const r = await request(`/api/platforms/${encodeURIComponent(id)}/open-panel`, { method: 'POST', body: query ? { query } : undefined })
    if (!r || !r.opened) return r
    // 安卓壳：容器里没有 xdg-open，服务端打开是空操作，改由 App 起系统浏览器。
    if (window.W2ABridge && typeof window.W2ABridge.openExternal === 'function') {
      try { window.W2ABridge.openExternal(r.opened) } catch { /* 打开失败不阻塞业务流程 */ }
      return r
    }
    // 浏览器直连部署（headless 服务器）：服务端 xdg-open 是空操作（无显示器），
    // 且 127.0.0.1 在用户浏览器里指向用户自己的电脑。把面板 URL 改写为
    // 主域名下的子路径（与 nginx 反代一致），由浏览器直接打开。
    // 端口 → 子路径映射：
    //   17899=magpie-web → /magpie/(前缀剥离,HTML 资源全相对路径)
    //   6789=lingxi     → 原样保留 /panel/(其 HTML/API 全在此前缀下,零冲突)
    //
    // 关键前提：只有「页面本身经公网反代访问」时才改写。桌面壳与本机浏览器
    // 的 window.location 就是 127.0.0.1:17800（壳自己托管 UI），此时把
    // 127.0.0.1:6789 改写成 <origin>/panel 会指到壳的 17800 上（无此路由），
    // 结果是空白页；本机浏览器本来就能直连各端口，原样打开即可。
    const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
    const rewrite = (url) => {
      try {
        const u = new URL(url)
        if (u.hostname !== '127.0.0.1') return { url, mapped: true }
        // 页面打开在本机（桌面壳 / 本机浏览器 / file:// 回退页）：直接开原地址
        if (isLoopback(window.location.hostname) || !window.location.origin || window.location.origin === 'null') {
          return { url, mapped: true }
        }
        let path = u.pathname
        if (u.port === '17899') path = '/magpie/' + path.replace(/^\//, '')
        if (u.port === '17899' || u.port === '6789') {
          return { url: window.location.origin + path + u.search, mapped: true }
        }
        return { url, mapped: false }
      } catch { return { url, mapped: false } }
    }
    const { url, mapped } = rewrite(r.opened)
    if (mapped) {
      window.open(url, '_blank', 'noopener')
    } else {
      // 无公网映射的面板（如自研网关原面板）：明确告知替代入口，而不是静默无反应
      throw new Error('该面板仅监听本机、无公网入口；请使用卡片上的「管理」按钮（账号/签到/统计/日志）')
    }
    return r
  },

  // 自研网关原生管理：统一视图 / 日志 / 受限动作。
  // 凭据（CodeArts admin_key、Lingxi/Loomy api_key）全部留在壳后台，
  // 这里拿到的只有脱敏后的账号与统计。
  gatewayPanel: (id) => request(`/api/platforms/${encodeURIComponent(id)}/panel`, { timeout: 30000 }),
  gatewayLogs: (id, lines = 200) => request(`/api/platforms/${encodeURIComponent(id)}/panel/logs?lines=${lines}`, { timeout: 30000 }),
  gatewayPanelAction: (id, action, body = {}) => request(`/api/platforms/${encodeURIComponent(id)}/panel`, {
    method: 'POST', body: { ...body, action }, timeout: 120000,
  }),

  // 代理连通性验证：拿填写的地址真的发一次请求（后端固定探 GitHub API）
  verifyProxy: (url) => request('/api/proxy/verify', { method: 'POST', body: { url }, timeout: 30000 }),

  // 壳自身更新检查。壳不是平台，不能借 /api/platforms/:id/update/check
  // （此前传 'hub' 占位，而自研 Hub 已移除，永远 404）。
  checkShellUpdate: () => request('/api/shell/update/check', { method: 'POST', timeout: 60000 }),
  shellUpdateStatus: () => request('/api/shell/update/status'),
  downloadShellUpdate: () => request('/api/shell/update/download', { method: 'POST', timeout: 30000 }),
  installShellUpdate: () => request('/api/shell/update/install', { method: 'POST', timeout: 120000 }),

  updatesSummary: async () => {
    const d = await request('/api/updates/summary')
    const items = Array.isArray(d?.items)
      ? d.items
      : (Array.isArray(d?.updates) ? d.updates : []).map((u) => ({
          ...u,
          updateAvailable: u.updateAvailable ?? u.hasUpdate ?? false,
          latest: u.latest ?? u.current
        }))
    return { ...d, items }
  },

  hubStatus: async () => {
    const d = await request('/api/hub/status')
    // 聚合层是 magpie：把壳返回的字段映射成页面用的形状
    return {
      ...d,
      state: stateOf(d),
      baseUrl: d.baseUrl ?? d.gateway ?? 'http://127.0.0.1:3425',
      listen: d.listen ?? '127.0.0.1:3425',
      apiKey: d.apiKey ?? '',
      modelRoutes: (d.modelRoutes ?? []).map((r) => ({
        ...r,
        // 壳给的是 {pattern, chain, routing}；页面用 {pattern, chain}
        chain: Array.isArray(r.chain) ? r.chain : []
      })),
      upstreams: (d.upstreams || []).map((u) => ({ ...u, state: stateOf(u) }))
    }
  },
  hubReload: () => request('/api/hub/reload', { method: 'POST' }),

  // magpie 内核实管的 provider 清单（origin: plugin=我们接入的 / official=官方插件）
  magpieProviders: () => request('/api/magpie/providers'),
  // magpie 内核版本与最新 release 对比
  magpieVersion: () => request('/api/magpie/version'),
  // 直接执行 magpie update（下载并替换内核）
  magpieUpdate: () => request('/api/magpie/update', { method: 'POST', timeout: 30000 }),
  // 未安装时一键下载 magpie
  magpieInstall: () => request('/api/magpie/install', { method: 'POST', timeout: 30000 }),
  magpieInstallStatus: () => request('/api/magpie/install'),
  // magpie 支持的完整 provider 目录（含未安装）
  magpiePresets: (refresh) => request(`/api/magpie/presets${refresh ? '?refresh=1' : ''}`, { timeout: 30000 }),
  // 社区插件市场（Trae / Qoder / WorkBuddy / Loomy / CodeArts …）
  magpiePlugins: (refresh) => request(`/api/magpie/plugins${refresh ? '?refresh=1' : ''}`, { timeout: 30000 }),
  // 同模型跨平台路由组：读取共享组与调整成员顺序
  routingGroups: () => request('/api/magpie/routing-groups', { timeout: 30000 }),
  // 模型目录：同模型跨平台聚合 + 各平台倍率（「模型列表 / 优先级」两视图共用）
  modelCatalog: () => request('/api/magpie/model-catalog', { timeout: 60000 }),
  reorderRoutingGroup: (id, members) => request('/api/magpie/routing-groups', {
    method: 'POST', body: { id, members }, timeout: 40000,
  }),
  // Hub 绑定：用勾选的平台新建一个顺序路由组
  bindRoutingGroup: ({ id, name, providers }) => request('/api/magpie/routing-groups', {
    method: 'POST', body: { action: 'bind', id, name, providers }, timeout: 60000,
  }),
  deleteRoutingGroup: (id) => request('/api/magpie/routing-groups', {
    method: 'POST', body: { action: 'delete', id }, timeout: 60000,
  }),
  magpiePluginPanel: (pkg, provider) => request(`/api/magpie/plugin-panel?${new URLSearchParams({ package: pkg, provider })}`, { timeout: 40000 }),
  magpiePluginAction: (pkg, provider, action, body = {}) => request('/api/magpie/plugin-panel', {
    method: 'POST', body: { ...body, package: pkg, provider, action }, timeout: 60000,
  }),
  magpieAddPlugin: (pkg) => request('/api/magpie/plugins/add', { method: 'POST', body: { package: pkg }, timeout: 300000 }),
  magpieRemovePlugin: (pkg) => request('/api/magpie/plugins/remove', { method: 'POST', body: { package: pkg }, timeout: 60000 }),
  // 插件登录（OAuth 设备码）：探方式 → 启动 → 轮询状态
  magpieLoginMethods: (provider) => request(`/api/magpie/login/methods?provider=${encodeURIComponent(provider)}`, { timeout: 30000 }),
  magpieLogin: (provider, method) => request('/api/magpie/login', { method: 'POST', body: { provider, method }, timeout: 60000 }),
  magpieLoginStatus: (provider) => request(`/api/magpie/login/status?provider=${encodeURIComponent(provider)}`),
  magpieLogout: (provider) => request('/api/magpie/logout', { method: 'POST', body: { provider }, timeout: 60000 }),
  // magpie 网关自身可观测数据：overview|quotas|usage|requests|mcp|trace|statusline
  magpieGateway: (what, opts = {}) => {
    const qs = new URLSearchParams({ what, ...opts }).toString()
    return request(`/api/magpie/gateway?${qs}`, { timeout: 15000 })
  },
  // 安装 / 移除 provider（走 magpie CLI）
  magpieAddProvider: (id, key, args) => request('/api/magpie/providers/add', { method: 'POST', body: { id, key, args }, timeout: 180000 }),
  magpieRemoveProvider: (id) => request('/api/magpie/providers/remove', { method: 'POST', body: { id }, timeout: 60000 }),
  // Gateway Key 额度：原生页面只有日/周/月，这里补每 N 天/每 N 小时。
  magpieGatewayKeys: () => request('/api/magpie/gateway-keys', { timeout: 45000 }),
  magpieSetGatewayKeyLimit: (keyId, limit, index) => request('/api/magpie/gateway-keys/limit', {
    method: 'POST', body: { keyId, limit, index }, timeout: 45000,
  }),
  magpieResetGatewayKeyLimit: (keyId, index) => request('/api/magpie/gateway-keys/reset-limit', {
    method: 'POST', body: { keyId, index }, timeout: 45000,
  }),

  // 公网模型 aliases：只允许选择 Key/provider，权限与目标由后端规划。
  magpieAliasSync: () => request('/api/magpie/alias-sync', { timeout: 45000 }),
  magpieAliasAction: (action, body = {}) => request('/api/magpie/alias-sync', {
    method: 'POST', body: { action, ...body }, timeout: 45000,
  }),

  // 统一外网访问：秘密只提交到本机 Manager；远程会话使用同源 Cookie + CSRF。
  tunnels: () => request('/api/tunnels'),
  tunnelBinaryStatus: () => request('/api/tunnels/binary/status'),
  installTunnelBinary: () => request('/api/tunnels/binary/install', { method: 'POST', timeout: 30000 }),
  saveTunnelConfig: (id, patch) => request(`/api/tunnels/${encodeURIComponent(id)}/config`, {
    method: 'PUT', body: patch, timeout: 30000,
  }),
  preflightTunnel: (id) => request(`/api/tunnels/${encodeURIComponent(id)}/preflight`, { method: 'POST', timeout: 30000 }),
  verifyTunnelToken: (id, token) => request(`/api/tunnels/${encodeURIComponent(id)}/verify-token`, {
    method: 'POST', body: { token }, timeout: 60000,
  }),
  startTunnel: (id) => request(`/api/tunnels/${encodeURIComponent(id)}/start`, { method: 'POST', timeout: 30000 }),
  stopTunnel: (id) => request(`/api/tunnels/${encodeURIComponent(id)}/stop`, { method: 'POST', timeout: 60000 }),
  tunnelLogs: (id, tail = 200) => request(`/api/tunnels/${encodeURIComponent(id)}/logs?tail=${tail}`),
  setTunnelManagerPassword: (currentPassword, newPassword) => request('/api/tunnels/manager/password', {
    method: 'PUT', body: { currentPassword, newPassword }, timeout: 30000,
  }),

  getSettings: () => request('/api/settings'),
  putSettings: (settings) => request('/api/settings', { method: 'PUT', body: settings })
}, {
  get(live, method) {
    if (isMock) {
      if (Object.prototype.hasOwnProperty.call(mockApi, method)) return mockApi[method]
      if (typeof live[method] === 'function') return async () => { throw new Error('演示模式暂未提供此操作，请连接 Manager API 后使用') }
    }
    return live[method]
  },
})

/**
 * SSE 实时日志流。
 * @param {string[]} ids 平台 id 列表（逐个开 SSE 连接）
 * @param {(line: {id: string, text: string}) => void} onLine
 * @returns {() => void} 取消函数
 */
function appendOnlyNewLines(previous, current) {
  const maxOverlap = Math.min(previous.length, current.length)
  for (let size = maxOverlap; size > 0; size--) {
    let same = true
    for (let i = 0; i < size; i++) {
      if (previous[previous.length - size + i] !== current[i]) {
        same = false
        break
      }
    }
    if (same) return current.slice(size)
  }
  return current
}

/** Cloudflare 部分链路不转发 SSE；远程管理会话改用去重轮询，避免 EventSource 永久空等。 */
function openPollingLogStream(ids, onLine) {
  let alive = true
  let running = false
  let timer = null
  const previous = new Map()
  const poll = async () => {
    if (!alive || running) return
    running = true
    try {
      await Promise.all(ids.map(async (id) => {
        try {
          const result = await api.getLogs(id, 200)
          const current = Array.isArray(result?.lines) ? result.lines : []
          const old = previous.get(id) || []
          for (const text of appendOnlyNewLines(old, current)) onLine({ id, text })
          previous.set(id, current)
        } catch {
          // 单个平台失败不影响其他平台，下一轮自动恢复。
        }
      }))
    } finally {
      running = false
      if (alive) timer = setTimeout(poll, 2000)
    }
  }
  void poll()
  return () => {
    alive = false
    if (timer) clearTimeout(timer)
  }
}

export function openLogStream(ids, onLine) {
  if (isMock) return mockLogStream(ids, onLine)
  // 安卓壳的请求走原生桥接，没有可用的 SSE，直接使用去重轮询回退。
  if (remoteCsrf() || window.__W2A_ANDROID__) return openPollingLogStream(ids, onLine)
  const sources = []
  for (const id of ids) {
    try {
      const es = new EventSource(`${BASE}/api/platforms/${encodeURIComponent(id)}/logs/stream`)
      es.onmessage = (ev) => {
        if (typeof ev.data === 'string' && ev.data.length) onLine({ id, text: ev.data })
      }
      es.onerror = () => { /* EventSource 自动重连；错误时静默，由全局横幅兜底 */ }
      sources.push(es)
    } catch {
      // 单个平台连接失败不阻塞其余平台
    }
  }
  return () => sources.forEach((s) => { try { s.close() } catch { /* ignore */ } })
}

export { MODE as apiMode, BASE as apiBase }
