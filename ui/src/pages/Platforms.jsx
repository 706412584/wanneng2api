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
  // 插件安装/卸载后递增，驱动上方「已安装插件」区块刷新
  // （必须放在任何条件 return 之前：Hook 数量要稳定）
  const [pluginRev, setPluginRev] = useState(0)

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
      {/* 自研网关与内核同属"我在跑的服务"，放在同一网格里统一排序 */}
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
        {corePlatforms.map((p) => (
          <PlatformCard
            key={p.id}
            p={p}
            busy={acting[p.id]}
            onAction={doAction}
            onOpenPanel={openPanel}
          />
        ))}
        <InstalledPlugins rev={pluginRev} onRemoved={() => setPluginRev((v) => v + 1)} />
      </div>

      <PluginMarket onInstalled={() => setPluginRev((v) => v + 1)} onRemoved={() => setPluginRev((v) => v + 1)} />
      <Collapsible title="已配置的内置 Provider" summaryKey="已接入的厂商 / 中转 / 订阅">
        <MagpieProviders />
      </Collapsible>
      <Collapsible title="厂商直连与中转（填 API Key）" summaryKey="70 个预置，适合已有 key 的场景">
        <MagpieCatalog />
      </Collapsible>
    </>
  )
}

/** 已安装的平台型插件：安装后出现在这里，与自研网关并列 */
/**
 * 插件平台卡片 —— 与自研网关卡同模板、同高度：
 *   head（名称+徽标 / 包名）→ stats（三栏）→ desc（固定 3 行）→ actions（贴底）
 * 登录走设备码流程：选方式 → 拿浏览器链接 → 轮询结果。
 */
function PluginPlatformCard({ p, busy, onRemove, onChanged }) {
  const toast = useToast()
  const [methods, setMethods] = useState(null)
  const [loginState, setLoginState] = useState(null)
  const [working, setWorking] = useState(false)
  const [dialog, setDialog] = useState(false)

  // 有进行中的登录就轮询状态
  useEffect(() => {
    if (!loginState || ['signed-in', 'failed', 'cancelled', 'interactive'].includes(loginState.status)) return
    const t = setInterval(async () => {
      try {
        const r = await api.magpieLoginStatus((p.providers || [])[0])
        if (r?.state) setLoginState(r.state)
      } catch { /* 轮询失败忽略 */ }
    }, 2000)
    return () => clearInterval(t)
  }, [loginState, p.providers])

  // 登录成功后提示并刷新列表
  useEffect(() => {
    if (loginState?.status === 'signed-in') {
      toast(`${p.name} 登录成功`)
      onChanged && onChanged()
    } else if (loginState?.status === 'failed') {
      toast(`${p.name} 登录未完成：${loginState.message || ''}`, 'err')
    }
  }, [loginState?.status])

  // provider 插件没有自己的前端：管理入口 = magpie 控制台（magpie-web 平台）
  const openPanelLogin = async () => {
    try {
      await api.openPanel('magpie-web')
      toast('已在系统浏览器打开 Magpie 控制台')
    } catch (e) {
      toast(`打开控制台失败：${e.message}`, 'err')
    }
  }

  const openLogin = async () => {
    setDialog(true)
    setMethods(null)
    try {
      const r = await api.magpieLoginMethods((p.providers || [])[0])
      setMethods(r.methods || [])
    } catch (e) {
      toast(`获取登录方式失败：${e.message}`, 'err')
      setMethods([])
    }
  }

  const doLogin = async (method) => {
    setDialog(false)
    setWorking(true)
    try {
      const r = await api.magpieLogin((p.providers || [])[0], method)
      setLoginState({ status: r.started ? 'awaiting-browser' : 'interactive', url: r.url, message: r.message })
      if (r.url) toast('已打开浏览器授权页，请完成登录')
      else toast(r.message || '登录进程已启动', r.started ? 'ok' : 'err')
    } catch (e) {
      toast(`登录失败：${e.message}`, 'err')
    } finally {
      setWorking(false)
    }
  }

  const doLogout = async () => {
    setWorking(true)
    try {
      const r = await api.magpieLogout((p.providers || [])[0])
      if (r.ok) { toast(`${p.name} 已登出`); setLoginState(null); onChanged && onChanged() }
      else toast(`登出失败：${(r.stderr || r.stdout || '').slice(0, 200)}`, 'err')
    } finally {
      setWorking(false)
    }
  }

  const signedIn = !!p.signedIn
  const pending = !!loginState && !['signed-in', 'failed', 'cancelled', 'interactive'].includes(loginState.status)
  const dot = signedIn ? 'healthy' : 'stopped'
  const statusText = signedIn ? '已登录' : (p.installed ? '待登录' : '未安装')

  return (
    <div className="card plat-card" data-kind="plugin">
      <div className="plat-head">
        <span className={`dot ${dot}`} />
        <div className="grow">
          <div className="name">
            {p.name}
            <span className="badge purple" title="magpie 社区插件">插件平台</span>
            {signedIn
              ? <span className="badge green">已登录</span>
              : <span className="badge gray">未登录</span>}
          </div>
          <div className="meta mono">{p.package.replace('@magpie-community/', '')}</div>
        </div>
      </div>

      <div className="plat-stats">
        <span>类型 <b>provider</b></span>
        <span className="ellipsis" title={(p.providers || []).join(' / ')}>
          provider <b>{(p.providers || []).join(' / ') || '—'}</b>
        </span>
        <span>状态 <b>{statusText}</b></span>
      </div>

      {/* 登录中提示与描述共用同一块区域，避免额外撑高卡片 */}
      {pending ? (
        <div className="catalog-desc" style={{ color: 'var(--blue)' }}>
          等待浏览器授权…{loginState.url && (
            <a href={loginState.url} target="_blank" rel="noreferrer">点此打开授权页</a>
          )}
        </div>
      ) : (
        <div className="catalog-desc">
          {(p.summary && (p.summary.zh || p.summary.en)) || '\u00a0'}
        </div>
      )}

      <div className="plat-actions">
        {signedIn
          ? <button className="btn ghost" disabled={working || busy} onClick={doLogout}>登出</button>
          : <button className="btn primary" disabled={working || busy} onClick={openLogin}>
              {working ? '启动登录…' : '登录'}
            </button>}
        <button className="btn sm" disabled={busy} onClick={openPanelLogin}>管理</button>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost" disabled={busy} onClick={onRemove}>{busy ? '卸载中…' : '卸载'}</button>
      </div>

      {dialog && (
        <div className="modal-mask" onClick={() => setDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">登录 {p.name}</div>
            {methods === null && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>读取登录方式…</div>}
            {methods && methods.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                该插件没有可用的非交互登录方式，请用命令行：<br />
                <span className="mono">magpie plugin login {(p.providers || [])[0]}</span>
              </div>
            )}
            {methods && methods.map((m) => (
              <button key={m.index} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => doLogin(m.index)}>
                {m.label}
              </button>
            ))}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDialog(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function InstalledPlugins({ rev, onRemoved }) {
  const fetchPlugins = useCallback(() => api.magpiePlugins(false), [])
  const { data, error, refresh } = usePolling(fetchPlugins, 0)
  const toast = useToast()
  const [busy, setBusy] = useState({})

  // 安装/卸载后立即拉一次，不必等用户手动刷新
  useEffect(() => {
    if (rev > 0) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])

  const installed = (data?.plugins || []).filter(
    (p) => p.installed && p.kind === 'provider'   // 只有 provider 型插件才算「平台」
  )

  const remove = async (p) => {
    setBusy((s) => ({ ...s, [p.package]: true }))
    try {
      const r = await api.magpieRemovePlugin(p.package)
      if (r.ok) {
        toast(`${p.name} 已卸载`)
        refresh()
        if (onRemoved) onRemoved()
      } else toast(`卸载失败：${(r.stderr || r.stdout || '').slice(0, 200)}`, 'err')
    } finally {
      setBusy((s) => { const n = { ...s }; delete n[p.package]; return n })
    }
  }

  if (error && !data) {
    return (
      <div className="card plat-card" data-kind="plugin">
        <div className="plat-head"><span className="dot error" /><div className="grow">
          <div className="name">已安装插件</div>
          <div className="meta">读取失败：{error.message}</div>
        </div></div>
      </div>
    )
  }
  if (!installed.length) return null

  return (
    <>
      {installed.map((p) => (
        <PluginPlatformCard
          key={p.package}
          p={p}
          busy={!!busy[p.package]}
          onRemove={() => remove(p)}
          onChanged={refresh}
        />
      ))}
    </>
  )
}

/** 可折叠区块，默认收起 */
function Collapsible({ title, summaryKey, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="card" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
      <button className="collapse-head" onClick={() => setOpen((v) => !v)}>
        <span className={`caret ${open ? 'open' : ''}`}>▸</span>
        <b>{title}</b>
        <span className="sub">{summaryKey}</span>
        <span style={{ flex: 1 }} />
        <span className="sub">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div style={{ padding: '0 16px 16px' }}>{children}</div>}
    </div>
  )
}

/** 插件市场：magpie 社区插件目录（Trae / Qoder / WorkBuddy / Loomy / CodeArts …） */
function PluginMarket({ onInstalled }) {
  const fetchPlugins = useCallback(() => api.magpiePlugins(false), [])
  const { data, error, loading, refresh } = usePolling(fetchPlugins, 0)
  const toast = useToast()

  const [kind, setKind] = useState('全部')
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState('all')   // all | installed | available
  const [busy, setBusy] = useState({})

  const plugins = data?.plugins || []
  const kinds = ['全部', ...Object.keys(data?.kinds || {})]
  const KIND_ZH = { provider: '接入', middleware: '中间件', agent: 'Agent', tools: '工具', page: '页面' }
  const installedCount = plugins.filter((p) => p.installed).length

  const shown = plugins.filter((p) => {
    if (kind !== '全部' && p.kind !== kind) return false
    if (scope === 'installed' && !p.installed) return false
    if (scope === 'available' && p.installed) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return p.name.toLowerCase().includes(q)
      || p.package.toLowerCase().includes(q)
      || (p.providers || []).some((x) => x.includes(q))
  })

  const install = async (p) => {
    setBusy((s) => ({ ...s, [p.package]: 'install' }))
    try {
      const r = await api.magpieAddPlugin(p.package)
      if (r.ok) {
        toast(`${p.name} 安装成功，已出现在上方平台区`)
        refresh()
        if (onInstalled) onInstalled()
      } else {
        toast(`安装失败：${(r.stderr || r.stdout || '未知错误').slice(0, 200)}`, 'err')
      }
    } catch (e) {
      toast(`安装失败：${e.message}`, 'err')
    } finally {
      setBusy((s) => { const n = { ...s }; delete n[p.package]; return n })
    }
  }

  const remove = async (p) => {
    setBusy((s) => ({ ...s, [p.package]: 'remove' }))
    try {
      const r = await api.magpieRemovePlugin(p.package)
      if (r.ok) { toast(`${p.name} 已卸载`); refresh() }
      else toast(`卸载失败：${(r.stderr || r.stdout || '').slice(0, 200)}`, 'err')
    } finally {
      setBusy((s) => { const n = { ...s }; delete n[p.package]; return n })
    }
  }

  return (
    <div className="card">
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          插件市场
          <span className="sub">magpie 社区 {plugins.length} 个 · 已装 {installedCount}</span>
        </span>
        <button className="btn sm" onClick={() => { refresh() }}>刷新</button>
      </div>

      {loading && !data && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>读取插件目录…</div>}
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>读取失败：{error.message}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <span className="sub" style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 2 }}>安装状态</span>
            {[
              ['all', `全部 ${plugins.length}`],
              ['installed', `已安装 ${installedCount}`],
              ['available', `未安装 ${plugins.length - installedCount}`],
            ].map(([v, label]) => (
              <button key={v} className={`btn sm ${scope === v ? 'primary' : 'ghost'}`} onClick={() => setScope(v)}>
                {label}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <input
              className="input sm" placeholder="搜索插件 / provider…" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ width: 210 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <span className="sub" style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 2 }}>类型</span>
            {kinds.map((k) => (
              <button key={k} className={`btn sm ${kind === k ? 'primary' : 'ghost'}`} onClick={() => setKind(k)}>
                {k === '全部' ? `全部 ${plugins.length}` : `${KIND_ZH[k] || k} ${data.kinds[k] || 0}`}
              </button>
            ))}
          </div>

          <div className="catalog-grid">
            {shown.map((p) => (
              <div key={p.package} className={`catalog-item ${p.installed ? 'installed' : ''}`}>
                <div className="catalog-head">
                  <b>{p.name}</b>
                  {p.installed
                    ? <span className="badge green">已安装</span>
                    : <span className="badge gray">{KIND_ZH[p.kind] || p.kind}</span>}
                </div>
                <div className="catalog-id mono">magpie 社区</div>
                <div className="catalog-desc">{(p.summary && (p.summary.zh || p.summary.en)) || ''}</div>
                <div className="catalog-foot">
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                    {p.providers.length ? p.providers.join(' / ') : p.package.replace('@magpie-community/', '')}
                  </span>
                  {p.installed
                    ? <button className="btn sm ghost" disabled={!!busy[p.package]} onClick={() => remove(p)}>
                        {busy[p.package] === 'remove' ? '卸载中…' : '卸载'}
                      </button>
                    : <button className="btn sm primary" disabled={!!busy[p.package]} onClick={() => install(p)}>
                        {busy[p.package] === 'install' ? '安装中…' : '安装'}
                      </button>}
                </div>
              </div>
            ))}
          </div>
          {!shown.length && <Empty icon="⇄" text="没有匹配的插件" />}
        </>
      )}
    </div>
  )
}

/**
 * magpie 完整 provider 目录：把 magpie 支持的 70+ 个预置全部列出来，
 * 已装的标「已安装」，未装的可直接填 key 安装。
 */
function MagpieCatalog() {
  const fetchPresets = useCallback(() => api.magpiePresets(false), [])
  const { data, error, loading, refresh } = usePolling(fetchPresets, 0)
  const toast = useToast()

  const [group, setGroup] = useState('全部')
  const [search, setSearch] = useState('')
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [dialog, setDialog] = useState(null)   // { preset }
  const [installing, setInstalling] = useState({})

  const presets = data?.presets || []
  const groups = ['全部', ...(data?.groups || [])]

  const shown = presets.filter((p) => {
    if (group !== '全部' && p.group !== group) return false
    if (onlyAvailable && p.installed) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return p.id.includes(q) || p.name.toLowerCase().includes(q) || p.originalName.toLowerCase().includes(q)
  })

  const doInstall = async (preset, key, extra) => {
    setInstalling((s) => ({ ...s, [preset.id]: true }))
    try {
      const r = await api.magpieAddProvider(preset.id, key, extra)
      if (r.ok) {
        toast(`${preset.name} 安装成功`)
        setDialog(null)
        refresh()
      } else {
        toast(`安装失败：${(r.stderr || r.stdout || '未知错误').slice(0, 200)}`, 'err')
      }
    } catch (e) {
      toast(`安装失败：${e.message}`, 'err')
    } finally {
      setInstalling((s) => { const n = { ...s }; delete n[preset.id]; return n })
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          添加 Provider
          <span className="sub">
            magpie 支持 {presets.length} 个 · 已安装 {presets.filter((p) => p.installed).length}
          </span>
        </span>
        <button className="btn sm" onClick={() => { refresh(); }}>刷新目录</button>
      </div>

      {loading && !data && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>读取 magpie 目录…</div>}
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>读取失败：{error.message}</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {groups.map((g) => (
              <button
                key={g}
                className={`btn sm ${group === g ? 'primary' : 'ghost'}`}
                onClick={() => setGroup(g)}
              >{g}</button>
            ))}
            <span style={{ flex: 1 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} />
              只看未安装
            </label>
            <input
              className="input sm"
              placeholder="搜索名称或 id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 200 }}
            />
          </div>

          <div className="catalog-grid">
            {shown.map((p) => (
              <div key={p.id} className={`catalog-item ${p.installed ? 'installed' : ''}`}>
                <div className="catalog-head">
                  <b>{p.name}</b>
                  {p.installed
                    ? <span className="badge green">已安装</span>
                    : <span className="badge gray">未安装</span>}
                </div>
                <div className="catalog-id mono">{p.originalName !== p.name ? `${p.originalName} · ${p.id}` : p.id}</div>
                {p.description && <div className="catalog-desc">{p.description}</div>}
                <div className="catalog-foot">
                  <span className="badge blue" style={{ fontSize: 10.5 }}>{p.group}</span>
                  {!p.installed && (
                    <button
                      className="btn sm primary"
                      disabled={!!installing[p.id]}
                      onClick={() => setDialog({ preset: p, key: '', extra: {} })}
                    >{installing[p.id] ? '安装中…' : '安装'}</button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {!shown.length && <Empty icon="⇄" text="没有匹配的 provider" />}
        </>
      )}

      {dialog && (
        <InstallDialog
          preset={dialog.preset}
          installing={!!installing[dialog.preset.id]}
          onCancel={() => setDialog(null)}
          onSubmit={doInstall}
        />
      )}
    </div>
  )
}

/** 安装表单：按 preset 声明决定要填 key 还是具名参数 */
function InstallDialog({ preset, installing, onCancel, onSubmit }) {
  const [key, setKey] = useState('')
  const [params, setParams] = useState(() => {
    const o = {}
    for (const p of preset.params || []) o[p] = ''
    return o
  })

  const extraArgs = Object.entries(params).filter(([, v]) => v.trim()).map(([k, v]) => `${k}=${v.trim()}`)
  const canSubmit = !installing && (!preset.needsKey || key.trim()) && (preset.params || []).every((p) => !params[p].trim() || true)

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">安装 {preset.name}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 14 }}>
          magpie 将执行：<span className="mono">{preset.command}</span>
        </div>

        {preset.needsKey && (
          <label className="field">
            <span>API Key</span>
            <input
              className="input"
              autoFocus
              placeholder="粘贴该服务商的 API Key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}

        {(preset.params || []).map((p) => (
          <label className="field" key={p}>
            <span>{p}</span>
            <input
              className="input"
              placeholder={`${p}=…`}
              value={params[p]}
              onChange={(e) => setParams((s) => ({ ...s, [p]: e.target.value }))}
            />
          </label>
        ))}

        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
          安装后可在「magpie 内核 Provider」表里看到它；模型清单由 magpie 自动拉取。
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel} disabled={installing}>取消</button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => onSubmit(preset, key.trim(), extraArgs)}>
            {installing ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
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
    <div className="card plat-card" data-kind={p.type === 'external' ? 'core' : 'own'}>
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
