// 概览页：6 指标卡 + 平台健康时间线（各平台状态灯 + 最近事件）
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Empty, ErrorBox, Loading, StateDot, STATE_TEXT } from '../components/Bits'
import { fmtAgo, fmtNum, fmtTokens, fmtUptime } from '../utils/format'

export default function Overview() {
  const fetchOverview = useCallback(() => api.getOverview(), [])
  const fetchPlatforms = useCallback(() => api.listPlatforms(), [])
  const ov = usePolling(fetchOverview, 5000)
  const pf = usePolling(fetchPlatforms, 5000)

  if (ov.loading && !ov.data) return <Loading text="加载概览数据…" />
  if (ov.error && !ov.data) return <ErrorBox error={ov.error} onRetry={ov.refresh} />
  if (!ov.data) return <Empty />

  const d = ov.data
  const runningCount = d.platforms.filter((p) => ['healthy', 'degraded', 'starting'].includes(p.state)).length
  const hubOk = d.hub?.state === 'healthy'

  const nameOf = (id) => pf.data?.find((p) => p.id === id)?.name || id
  const stateOf = (id) => pf.data?.find((p) => p.id === id)?.state || 'stopped'

  return (
    <>
      <div className="metrics">
        <div className="metric">
          <div className="label">运行平台数</div>
          <div className="value">{runningCount}<span style={{ fontSize: 14, color: 'var(--text-3)' }}> / {d.platforms.length}</span></div>
          <span className={`hint ${runningCount === d.platforms.length ? 'ok' : 'info'}`}>
            {runningCount === d.platforms.length ? '全部运行' : `${d.platforms.length - runningCount} 个未运行`}
          </span>
        </div>
        <div className="metric">
          <div className="label">Hub 状态</div>
          <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StateDot state={d.hub?.state || 'stopped'} />
            <span style={{ fontSize: 17 }}>{STATE_TEXT[d.hub?.state] || d.hub?.state || '—'}</span>
          </div>
          <span className={`hint ${hubOk ? 'ok' : 'warn'}`}>统一入口 :17810</span>
        </div>
        <div className="metric">
          <div className="label">今日请求</div>
          <div className="value">{fmtNum(d.todayRequests)}</div>
          <span className="hint neutral">经 Hub 转发</span>
        </div>
        <div className="metric">
          <div className="label">今日 Token</div>
          <div className="value">{fmtTokens(d.todayTokens)}</div>
          <span className="hint neutral">prompt + completion</span>
        </div>
        <div className="metric">
          <div className="label">健康告警</div>
          <div className="value" style={{ color: d.alerts?.length ? 'var(--orange)' : undefined }}>{d.alerts?.length ?? 0}</div>
          <span className={`hint ${d.alerts?.length ? 'warn' : 'ok'}`}>{d.alerts?.length ? '需要关注' : '一切正常'}</span>
        </div>
        <div className="metric">
          <div className="label">待更新</div>
          <div className="value" style={{ color: d.pendingUpdates ? 'var(--blue)' : undefined }}>{d.pendingUpdates ?? 0}</div>
          <span className={`hint ${d.pendingUpdates ? 'info' : 'ok'}`}>
            {d.pendingUpdates ? <Link to="/updates">前往更新中心 →</Link> : '均为最新版'}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          平台健康状态
          <span className="sub">每 5 秒自动刷新</span>
        </div>
        {ov.error && <div className="banner" style={{ borderRadius: 8, marginBottom: 10, padding: '8px 12px' }}>刷新失败：{ov.error.message}（显示上次数据）</div>}
        <div className="platform-grid">
          {(pf.data || d.platforms).map((p) => {
            const id = p.id
            const st = p.state || stateOf(id)
            return (
              <div key={id} className="card plat-card" style={{ boxShadow: 'none' }}>
                <div className="plat-head">
                  <StateDot state={st} />
                  <div className="grow">
                    <div className="name">{nameOf(id)}</div>
                    <div className="meta">uptime {fmtUptime(p.uptimeSec)}</div>
                  </div>
                  <Link className="btn sm ghost" to="/platforms">管理 →</Link>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">最近事件</div>
        <RecentEvents />
      </div>
    </>
  )
}

/** 最近事件：从各平台 detail 的 history 聚合（失败静默降级为平台状态快照） */
function RecentEvents() {
  const fetchPlatforms = useCallback(() => api.listPlatforms(), [])
  const pf = usePolling(fetchPlatforms, 8000)

  if (!pf.data) return <Loading text="读取事件…" />

  const ids = pf.data.map((p) => p.id)
  return (
    <EventList ids={ids} />
  )
}

/** 聚合各平台 detail.history，按时间倒序取前 12 条 */
function EventList({ ids }) {
  const [events, setEvents] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const results = await Promise.allSettled(ids.map((id) => api.getPlatformDetail(id)))
      if (!alive) return
      const evs = []
      let failures = 0
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value?.history)) {
          for (const h of r.value.history) {
            evs.push({ ts: h.ts, id: r.value.id, name: r.value.name, event: h.event, note: h.note })
          }
        } else {
          failures++
        }
      }
      evs.sort((a, b) => b.ts - a.ts)
      setEvents(evs.slice(0, 12))
      setErr(failures === ids.length && ids.length > 0 ? new Error('所有平台详情均不可达') : null)
    }
    load()
    const t = setInterval(load, 8000)
    return () => { alive = false; clearInterval(t) }
  }, [ids.join(',')])

  if (err && !events) return <div className="empty"><div className="big">⚠️</div><div>事件读取失败：{err.message}</div></div>
  if (!events) return <Loading text="聚合事件…" />
  if (!events.length) return <Empty icon="🗂" text="暂无事件记录" />

  return (
    <div className="timeline">
      {events.map((e, i) => (
        <div className="tl-item" key={`${e.ts}-${e.id}-${i}`}>
          <span className="when">{fmtAgo(e.ts)}</span>
          <span className="what">
            <StateDot state={e.event} /> <b>{e.name}</b> — {STATE_TEXT[e.event] || e.event}
            <span style={{ color: 'var(--text-3)' }}> {e.note ? `· ${e.note}` : ''}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
