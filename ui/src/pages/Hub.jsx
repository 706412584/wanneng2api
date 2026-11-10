// Hub 页：magpie 网关可视化面板
// 数据全部来自 magpie 自己的可观测 API（:3425，无需鉴权），由 Manager API 代理：
//   /v1/magpie/quotas         各订阅额度
//   /v1/magpie/usage          调用量/Token/费用（含按天曲线）
//   /v1/magpie/usage/requests 逐请求明细
//   /v1/magpie/mcp            MCP 服务清单
//   /                    网关自身信息（端口、版本、模型数、支持的路由）
import { useCallback, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Empty, ErrorBox, Loading, StateDot, STATE_TEXT } from '../components/Bits'
import { fmtNum, fmtTime, fmtAgo } from '../utils/format'

const PERIODS = [
  ['today', '今天'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['all', '全部'],
]

export default function Hub() {
  const [period, setPeriod] = useState('7d')

  const fetchInfo = useCallback(() => api.magpieGateway('overview'), [])
  const fetchHub = useCallback(() => api.hubStatus(), [])
  const fetchQuotas = useCallback(() => api.magpieGateway('quotas'), [])
  const fetchUsage = useCallback(() => api.magpieGateway('usage', { period }), [period])
  const fetchReqs = useCallback(() => api.magpieGateway('requests', { period, limit: 30 }), [period])

  const info = usePolling(fetchInfo, 30000)
  const hub = usePolling(fetchHub, 10000)
  const quotas = usePolling(fetchQuotas, 15000)
  const usage = usePolling(fetchUsage, 15000)
  const reqs = usePolling(fetchReqs, 10000)

  const toast = useToast()
  const [showKey, setShowKey] = useState(false)

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${label} 已复制到剪贴板`)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        toast(`${label} 已复制到剪贴板`)
      } catch (e) {
        toast(`复制失败：${e.message}`, 'err')
      }
    }
  }

  if (hub.loading && !hub.data) return <Loading text="连接 magpie 网关…" />
  if (hub.error && !hub.data) return <ErrorBox error={hub.error} onRetry={hub.refresh} />

  const baseUrl = hub.data?.baseUrl || 'http://127.0.0.1:3425'
  const gatewayState = hub.data?.state || 'stopped'
  const u = usage.data || {}
  const maxCalls = Math.max(1, ...(u.series || []).map((s) => s.calls || 0))

  return (
    <>
      {/* ── 入口 + 概览指标 ── */}
      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            统一入口
            <span className={`state-pill ${gatewayState}`}>
              <StateDot state={gatewayState} size={7} />
              {STATE_TEXT[gatewayState] || gatewayState}
            </span>
            {info.data?.version && <span className="badge blue">v{info.data.version}</span>}
          </span>
          <span className="sub">magpie 网关</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CopyRow label="Base URL" value={baseUrl} onCopy={copy} />
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            Claude Code / Codex / Gemini CLI / 任意 OpenAI SDK 只需配置以上 base_url。
            {info.data?.models ? ` 当前共 ${info.data.models} 个模型可路由。` : ''}
          </div>
        </div>
      </div>

      {/* ── 用量指标 ── */}
      <div className="metrics" style={{ marginTop: 16 }}>
        <Metric label="调用次数" value={fmtNum(u.calls)} hint={`${u.errors || 0} 次错误`} danger={u.errors > 0} />
        <Metric label="输入 Token" value={fmtNum(u.input)} hint="prompt" />
        <Metric label="输出 Token" value={fmtNum(u.output)} hint="completion" />
        <Metric label="费用" value={u.cost != null ? `$${(u.cost || 0).toFixed(4)}` : '—'} hint={u.unpriced ? `${u.unpriced} 次未定价` : '全部已定价'} />
        <Metric label="重试" value={fmtNum(u.retried)} hint="失败后换号/换上游" />
        <Metric label="流量" value={formatBytes((u.up_bytes || 0) + (u.down_bytes || 0))} hint={`↑${formatBytes(u.up_bytes || 0)} ↓${formatBytes(u.down_bytes || 0)}`} />
      </div>

      {/* ── 调用趋势 ── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>调用趋势 <span className="sub">按天 · 来自 magpie usage</span></span>
          <span style={{ display: 'flex', gap: 6 }}>
            {PERIODS.map(([v, label]) => (
              <button key={v} className={`btn sm ${period === v ? 'primary' : 'ghost'}`} onClick={() => setPeriod(v)}>{label}</button>
            ))}
          </span>
        </div>
        {(u.series || []).length === 0 ? (
          <Empty icon="▤" text="该区间没有调用记录" />
        ) : (
          <div className="bars">
            {(u.series || []).map((s) => (
              <div className="bar-col" key={s.time} title={`${s.label}：${s.calls} 次 · ${s.input + s.output} tokens`}>
                <div className="bar-fill" style={{ height: `${Math.max(2, (s.calls / maxCalls) * 100)}%`, opacity: s.calls ? 1 : 0.25 }} />
                <div className="bar-label">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 额度 + MCP ── */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', marginTop: 16 }}>
        <div className="card">
          <div className="card-title">订阅额度 <span className="sub">来自 magpie quotas</span></div>
          {quotas.loading && !quotas.data && <div className="sub">读取中…</div>}
          {quotas.error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{quotas.error.message}</div>}
          {quotas.data && !(quotas.data.data || []).length && <Empty icon="◔" text="没有已登录的订阅" />}
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>订阅</th><th>账号</th><th>额度</th><th>重置</th></tr>
              </thead>
              <tbody>
                {(quotas.data?.data || []).map((q, i) => (
                  <tr key={`${q.provider}-${i}`}>
                    <td>
                      <b>{q.name || q.provider}</b>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{q.provider}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{q.user || '—'}</td>
                    <td>
                      {(q.windows || []).length === 0
                        ? <span style={{ color: q.error ? 'var(--red)' : 'var(--text-3)', fontSize: 12 }}>
                            {q.error ? '登录失效' : '—'}
                          </span>
                        : (q.windows || []).map((w) => (
                            <div key={w.name} style={{ fontSize: 12 }}>
                              {w.name}: <b>{w.remaining ?? '—'}</b>
                              {w.used != null && w.remaining != null && (
                                <span style={{ color: 'var(--text-3)' }}> / {w.used + w.remaining}</span>
                              )}
                            </div>
                          ))}
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                      {(q.windows || []).map((w) => (w.resetsAt ? <div key={w.name}>{fmtAgo(Date.parse(w.resetsAt))}</div> : null))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-title">MCP 服务 <span className="sub">magpie 提供给 agent 的工具</span></div>
          <McpList />
        </div>
      </div>

      {/* ── 逐请求明细 ── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>请求明细 <span className="sub">最近 30 条 · 每 10 秒刷新</span></span>
          <button className="btn sm" onClick={() => { reqs.refresh(); usage.refresh(); quotas.refresh() }}>刷新</button>
        </div>

        {reqs.loading && !reqs.data && <div className="sub">读取中…</div>}
        {reqs.error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{reqs.error.message}</div>}
        {reqs.data && !(reqs.data.rows || []).length && <Empty icon="▥" text="该区间没有请求记录" />}

        {(reqs.data?.rows || []).length > 0 && (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th><th>来源</th><th>请求模型</th><th>实际服务</th>
                  <th>上游</th><th>状态</th><th>Token</th><th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {(reqs.data.rows || []).map((r, i) => (
                  // 该接口没有稳定唯一 id（无 route_id），用时间+来源+模型+序号兜底
                  <tr key={`${r.t}|${r.agent}|${r.model}|${i}`}>
                    <td style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmtTime(r.t)}</td>
                    <td style={{ fontSize: 12 }}>{r.agentName || r.agent || '—'}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.req || r.model}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.served || '—'}</td>
                    <td style={{ fontSize: 11.5 }}>{r.providerName || r.provider}</td>
                    <td>
                      <span className={`badge ${r.status === 200 ? 'green' : r.status === 429 ? 'orange' : 'red'}`}>
                        {r.status}
                      </span>
                      {r.tries > 1 && <span className="badge gray" style={{ marginLeft: 4 }}>×{r.tries}</span>}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      <span style={{ color: 'var(--text-3)' }}>入</span> {fmtNum(r.in)}
                      {' '}<span style={{ color: 'var(--text-3)' }}>出</span> {fmtNum(r.out)}
                    </td>
                    <td className="num" style={{ fontSize: 11.5 }}>{r.ms ? `${r.ms}ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 协议能力 ── */}
      {info.data?.apis?.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">网关支持的接口 <span className="sub">{info.data.apis.length} 个</span></div>
          <div className="api-chips">
            {info.data.apis.map((a) => <span key={a} className="chip mono">{a}</span>)}
          </div>
        </div>
      )}
    </>
  )
}

function Metric({ label, value, hint, danger }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value" style={{ color: danger ? 'var(--orange)' : undefined }}>{value}</div>
      {hint && <span className={`hint ${danger ? 'warn' : 'neutral'}`}>{hint}</span>}
    </div>
  )
}

function CopyRow({ label, value, onCopy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 72, fontSize: 12.5, color: 'var(--text-3)' }}>{label}</span>
      <code className="mono" style={{ flex: 1, fontSize: 12.5, background: 'var(--bg-soft)', padding: '7px 10px', borderRadius: 8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </code>
      <button className="btn sm" onClick={() => onCopy(value, label)}>复制</button>
    </div>
  )
}

function McpList() {
  const fetchMcp = useCallback(() => api.magpieGateway('mcp'), [])
  const { data, error } = usePolling(fetchMcp, 30000)

  if (error) return <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{error.message}</div>
  const servers = data?.servers || []
  if (!servers.length) return <Empty icon="⚙" text="没有注册的 MCP 服务" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {servers.map((s) => (
        <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
          <span className="badge green">MCP</span>
          <b>{s.title || s.name}</b>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{s.path}</span>
        </div>
      ))}
    </div>
  )
}

function formatBytes(n) {
  if (!n) return '0'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`
}