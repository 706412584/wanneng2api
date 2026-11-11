// Manager API 客户端 —— 端点形状严格按 docs/DESIGN.md §4.4
// 基址 http://127.0.0.1:17800（壳子主进程内嵌，仅 127.0.0.1）
import { mockApi, mockLogStream } from './mock'

// 生产构建（npm run build）默认连真实壳；开发服务器默认 mock。
// 之前构建产物落到 mock，打包后打开就是假数据，和桌面版应有的行为相反。
const MODE = (import.meta.env.VITE_API_MODE
  || (import.meta.env.PROD ? 'live' : 'mock')).toLowerCase()
const BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:17800').replace(/\/$/, '')
const TIMEOUT_MS = 8000

export const isMock = MODE === 'mock'

/**
 * 统一 fetch 封装：超时 + 非 2xx 抛错 + JSON 解析
 * @param {string} path 以 / 开头的 API 路径
 * @param {{method?: string, body?: any, timeout?: number}} opts
 */
async function request(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(BASE + path, {
      method,
      // X-Wanneng-Client：壳用 file:// 回退加载 UI 时 Origin 是 null，
// 与「任意网页的 sandbox iframe」无法区分。带这个自定义头证明是本台 UI
// （跨站写请求无法设置它，会先触发预检并被拒绝）。
      headers: {
        'X-Wanneng-Client': 'wanneng2api',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
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
    health: p.health ?? (stateOf(p) === 'healthy' ? 'ok' : 'unknown'),
    uptimeSec: p.uptimeSec ?? 0,
    updateAvailable: p.updateAvailable ?? p.hasUpdate ?? false
  }
}

function adaptPlatformList(r) {
  const arr = Array.isArray(r) ? r : (Array.isArray(r?.platforms) ? r.platforms : [])
  return arr.map(adaptPlatform)
}

// ---------- 平台 ----------
export const api = {
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

  checkUpdate: (id) => request(`/api/platforms/${encodeURIComponent(id)}/update/check`, { method: 'POST' }),
  applyUpdate: (id, checkInfo) => request(`/api/platforms/${encodeURIComponent(id)}/update/apply`, { method: 'POST', body: checkInfo ? { checkInfo } : undefined }),
  openPanel: (id, query) => request(`/api/platforms/${encodeURIComponent(id)}/open-panel`, { method: 'POST', body: query ? { query } : undefined }),

  // 自研网关原生管理：统一视图 / 日志 / 受限动作。
  // 凭据（CodeArts admin_key、Lingxi/Loomy api_key）全部留在壳后台，
  // 这里拿到的只有脱敏后的账号与统计。
  gatewayPanel: (id) => request(`/api/platforms/${encodeURIComponent(id)}/panel`, { timeout: 30000 }),
  gatewayLogs: (id, lines = 200) => request(`/api/platforms/${encodeURIComponent(id)}/panel/logs?lines=${lines}`, { timeout: 30000 }),
  gatewayPanelAction: (id, action, body = {}) => request(`/api/platforms/${encodeURIComponent(id)}/panel`, {
    method: 'POST', body: { ...body, action }, timeout: 120000,
  }),

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
  reorderRoutingGroup: (id, members) => request('/api/magpie/routing-groups', {
    method: 'POST', body: { id, members }, timeout: 40000,
  }),
  // Hub 绑定：用勾选的平台新建一个顺序路由组
  bindRoutingGroup: ({ id, name, providers }) => request('/api/magpie/routing-groups', {
    method: 'POST', body: { action: 'bind', id, name, providers }, timeout: 60000,
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

  getSettings: () => request('/api/settings'),
  putSettings: (settings) => request('/api/settings', { method: 'PUT', body: settings })
}

/**
 * SSE 实时日志流。
 * @param {string[]} ids 平台 id 列表（逐个开 SSE 连接）
 * @param {(line: {id: string, text: string}) => void} onLine
 * @returns {() => void} 取消函数
 */
export function openLogStream(ids, onLine) {
  if (isMock) return mockLogStream(ids, onLine)
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
