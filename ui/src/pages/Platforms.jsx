// 平台管理页：每平台一卡（状态灯/版本/端口/uptime/启停/健康/面板/更新徽标/日志入口 + sub2api 依赖圆点）
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, isMock } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Empty, ErrorBox, Loading, StateDot, STATE_TEXT } from '../components/Bits'
import { fmtUptime } from '../utils/format'

const BUSY_STATES = ['starting', 'updating']

export default function Platforms() {
  const fetchPlatforms = useCallback(() => api.listPlatforms(), [])
  const { data, error, loading, refresh, setData } = usePolling(fetchPlatforms, 5000)
  const toast = useToast()
  const [acting, setActing] = useState({}) // id -> action 进行中

  /** 乐观更新 + POST，失败回滚并提示；成功后立即轮询校正 */
  const doAction = async (p, action, label) => {
    if (acting[p.id]) return
    const prev = p
    // 乐观更新
    const optimistic = { ...p }
    if (action === 'start' || action === 'restart') { optimistic.state = 'starting'; optimistic.health = 'pending' }
    if (action === 'stop') { optimistic.state = 'stopped'; optimistic.health = 'off'; optimistic.pid = null }
    if (action === 'enable') optimistic.enabled = true
    if (action === 'disable') { optimistic.enabled = false; optimistic.state = 'stopped'; optimistic.health = 'off'; optimistic.pid = null }
    setData((list) => list.map((x) => (x.id === p.id ? optimistic : x)))
    setActing((a) => ({ ...a, [p.id]: action }))
    try {
      await api.platformAction(p.id, action)
      toast(`${prev.name} ${label}指令已下发`)
    } catch (e) {
      setData((list) => list.map((x) => (x.id === p.id ? prev : x)))
      toast(`${prev.name} ${label}失败：${e.message}`, 'err')
    } finally {
      setActing((a) => { const n = { ...a }; delete n[p.id]; return n })
      setTimeout(refresh, 400)
    }
  }

  const openPanel = async (p) => {
    try {
      await api.openPanel(p.id)
      if (!isMock) toast(`已在系统浏览器打开 ${p.name} 面板`)
      else toast(`（mock）将打开 http://127.0.0.1:${p.port}/`)
    } catch (e) {
      toast(`打开面板失败：${e.message}`, 'err')
    }
  }

  if (loading && !data) return <Loading text="加载平台列表…" />
  if (error && !data) return <ErrorBox error={error} onRetry={refresh} />
  if (!data?.length) return <Empty icon="▦" text="尚无注册平台，请在壳子 platforms.json 中登记" />

  const ourPlatforms = data.filter((p) => p.type !== 'external')
  const corePlatforms = data.filter((p) => p.type === 'external')

  return (
    <>
      <div className="platform-grid">
        {ourPlatforms.map((p) => (
          <PlatformCard
            key={p.id}
            p={p}
            busy={acting[p.id]}
            onAction={doAction}
            onOpenPanel={openPanel}
          />
        ))}
      </div>

      {corePlatforms.length > 0 && (
        <div className="platform-grid" style={{ marginTop: 16 }}>
          {corePlatforms.map((p) => (
            <PlatformCard
              key={p.id}
              p={p}
              busy={acting[p.id]}
              onAction={doAction}
              onOpenPanel={openPanel}
            />
          ))}
        </div>
      )}

      <MagpieProviders />
    </>
  )
}

/** magpie 内核实管的 provider 清单：我们接入的标「插件」，其余标「官方」 */
function MagpieProviders() {
  const fetchProviders = useCallback(() => api.magpieProviders(), [])
  const { data, error, loading, refresh } = usePolling(fetchProviders, 15000)

  const providers = data?.providers || []

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          magpie 内核 Provider
          <span className="sub">
            插件 {data?.pluginCount ?? 0} · 官方 {data?.officialCount ?? 0}
          </span>
        </span>
        <button className="btn sm" onClick={refresh}>刷新</button>
      </div>

      {loading && !data && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>读取中…</div>}
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>读取失败：{error.message}</div>}

      {data && !providers.length && (
        <Empty icon="⇄" text="magpie 尚未配置任何 provider" />
      )}

      {providers.length > 0 && (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>来源</th>
                <th>Provider</th>
                <th>上游地址</th>
                <th>协议</th>
                <th>模型</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.origin === 'plugin'
                      ? <span className="badge purple" title="我们自研网关接入的 provider">插件</span>
                      : <span className="badge blue" title="magpie 官方或社区插件提供">官方</span>}
                  </td>
                  <td>
                    <b>{p.name}</b>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }} className="mono">{p.id}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{p.baseUrl || '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {p.anthropic ? (
                      <span>
                        <span className="badge green">OpenAI</span>{' '}
                        <span className="badge blue">Anthropic</span>
                      </span>
                    ) : (
                      <span className="badge green">OpenAI</span>
                    )}
                  </td>
                  <td className="num">{p.models || '—'}</td>
                  <td>
                    {p.signedIn
                      ? <span className="badge green">已配置</span>
                      : <span className="badge gray">未登录</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.configDir && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
          数据来源：<span className="mono">{data.configDir}</span>
          （providers.json / plugin-providers.json）
        </div>
      )}
    </div>
  )
}

function PlatformCard({ p, busy, onAction, onOpenPanel }) {
  const disabled = BUSY_STATES.includes(p.state) || !!busy
  const running = ['healthy', 'degraded', 'unhealthy', 'starting', 'updating'].includes(p.state)

  return (
    <div className="card plat-card">
      <div className="plat-head">
        <StateDot state={p.state} />
        <div className="grow">
          <div className="name">
            {p.name}
            <span className={`badge ${p.type === 'external' ? 'blue' : 'purple'}`} title={p.type === 'external' ? 'magpie 内核，由它自己管理生命周期' : '我们自研接入的网关'}>
              {p.type === 'external' ? '官方内核' : '插件'}
            </span>
            {p.adopted && <span className="badge gray" title="该端口上已有它自己的实例在运行，管理台只做监控，不负责启动">外部实例</span>}
            {!p.enabled && <span className="badge gray">已禁用</span>}
            {p.updateAvailable && <span className="badge orange">可更新</span>}
            {p.state === 'updating' && <span className="badge blue">更新中</span>}
          </div>
          <div className="meta">
            {p.type} · pid {p.pid ?? '—'} · :{p.port ?? '—'}{p.version ? ` · v${p.version}` : ''}
          </div>
        </div>
      </div>

      <div className="plat-stats">
        <span>状态 <b>{STATE_TEXT[p.state] || p.state}</b></span>
        <span>健康 <b>{p.health === 'ok' ? '正常' : p.health === 'off' ? '—' : p.health === 'pending' ? '等待' : p.health}</b></span>
        <span>运行 <b>{running ? fmtUptime(p.uptimeSec) : '—'}</b></span>
      </div>

      {p.lastError && <div className="plat-error">⚠ {p.lastError}</div>}

      {p.id === 'sub2api' && <DepDots p={p} />}

      <div className="plat-actions">
        {running ? (
          <>
            <button className="btn" disabled={disabled} onClick={() => onAction(p, 'restart', '重启')}>重启</button>
            <button className="btn danger" disabled={disabled} onClick={() => onAction(p, 'stop', '停止')}>停止</button>
          </>
        ) : (
          <button className="btn primary" disabled={disabled || !p.enabled} onClick={() => onAction(p, 'start', '启动')}>启动</button>
        )}
        {p.enabled
          ? <button className="btn ghost" disabled={disabled} onClick={() => onAction(p, 'disable', '禁用')}>禁用</button>
          : <button className="btn ghost" disabled={disabled} onClick={() => onAction(p, 'enable', '启用')}>启用</button>}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => onOpenPanel(p)} title={`http://127.0.0.1:${p.port}`}>打开面板</button>
        <Link className="btn sm" to={`/logs?id=${p.id}`}>日志</Link>
      </div>
    </div>
  )
}

/** sub2api 依赖三圆点（pg / redis / server）——从 detail 拉取 */
function DepDots({ p }) {
  const [deps, setDeps] = useState(null)
  const [failed, setFailed] = useState(false)

  // 随卡片轮询 detail
  useDetailPolling(p.id, setDeps, setFailed, p.state)

  const label = { pg: 'PG', redis: 'Redis', server: 'Server' }
  const mapState = (s) => (s === 'healthy' ? 'healthy' : s === 'starting' ? 'starting' : s === 'error' ? 'error' : 'stopped')

  return (
    <div className="dep-dots">
      <span style={{ color: 'var(--text-3)' }}>依赖进程</span>
      {failed && <span className="badge red">依赖状态获取失败</span>}
      {!failed && ['pg', 'redis', 'server'].map((k) => (
        <span className="dep-dot" key={k}>
          <span className={`dot ${deps ? mapState(deps[k]) : 'stopped'}`} />
          {label[k]}
        </span>
      ))}
    </div>
  )
}

function useDetailPolling(id, setDeps, setFailed, platState) {
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api.getPlatformDetail(id)
        if (alive) { setDeps(d.deps || null); setFailed(false) }
      } catch {
        if (alive) setFailed(true)
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [id, platState])
}
