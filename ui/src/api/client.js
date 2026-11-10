// Manager API 客户端 —— 端点形状严格按 docs/DESIGN.md §4.4
// 基址 http://127.0.0.1:17800（壳子主进程内嵌，仅 127.0.0.1）
import { mockApi, mockLogStream } from './mock'

const MODE = (import.meta.env.VITE_API_MODE || 'mock').toLowerCase()
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
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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

// ---------- 平台 ----------
export const api = {
  getOverview: () => request('/api/overview'),
  listPlatforms: () => request('/api/platforms'),
  getPlatformDetail: (id) => request(`/api/platforms/${encodeURIComponent(id)}/detail`),
  platformAction: (id, action) => request(`/api/platforms/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
  getLogs: (id, tail = 200) => request(`/api/platforms/${encodeURIComponent(id)}/logs?tail=${tail}`),

  checkUpdate: (id) => request(`/api/platforms/${encodeURIComponent(id)}/update/check`, { method: 'POST' }),
  applyUpdate: (id) => request(`/api/platforms/${encodeURIComponent(id)}/update/apply`, { method: 'POST' }),
  openPanel: (id) => request(`/api/platforms/${encodeURIComponent(id)}/open-panel`, { method: 'POST' }),

  updatesSummary: () => request('/api/updates/summary'),
  hubStatus: () => request('/api/hub/status'),
  hubReload: () => request('/api/hub/reload', { method: 'POST' }),

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
