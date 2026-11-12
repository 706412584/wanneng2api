// 设置页：manager.json 读写（general / update / sub2api）+ 关于区（版本/检查壳更新）
import { useCallback, useEffect, useState } from 'react'
import { api, apiMode } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Empty, ErrorBox, Loading } from '../components/Bits'

const PLATFORM_CHOICES = [
  { id: 'hub', label: 'Hub 聚合层' },
  { id: 'workbuddy', label: 'WorkBuddy2API' },
  { id: 'codearts', label: 'CodeArts2API' },
  { id: 'loomy', label: 'Loomy2API' },
  { id: 'sub2api', label: 'Sub2API' }
]

const EMPTY_SETTINGS = {
  general: { closeAction: 'tray', autoStart: false, startMinimized: false, autoStartPlatforms: [] },
  update: { checkOnLaunch: true, githubToken: '' },
  sub2api: { pgPort: 5433, redisPort: 6380 }
}

/** 代理范围：前四项由壳执行（挂 agent），后两项写入 magpie 自己的设置 */
const PROXY_SCOPES = [
  { id: 'selfUpdate', label: '壳自更新' },
  { id: 'platformUpdate', label: '平台更新（检查 + 下载）' },
  { id: 'pluginRegistry', label: '插件市场' },
  { id: 'magpieKernel', label: 'magpie 内核更新' },
  { id: 'magpieSubscription', label: '订阅流量（magpie proxy）' },
  { id: 'magpiePlugin', label: '插件流量（magpie pluginProxy）' }
]

export default function Settings() {
  const fetchSettings = useCallback(() => api.getSettings(), [])
  const { data, error, loading, refresh } = usePolling(fetchSettings, 0)
  const toast = useToast()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [shellChecking, setShellChecking] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyResult, setProxyResult] = useState(null)

  useEffect(() => {
    if (data) setForm(normalize(data))
  }, [data])

  const set = (section, key, value) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], [key]: value } }))
  }

  const toggleAutoStartPlatform = (id) => {
    setForm((f) => {
      const cur = f.general.autoStartPlatforms || []
      return {
        ...f,
        general: {
          ...f.general,
          autoStartPlatforms: cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id)
        }
      }
    })
  }

  // 代理范围勾选：scopes 是二级对象，用 set 直接改会整体覆盖成「只有这一个键」，
  // 所以单独合并，并保证未勾的键保留 false（后端也会补默认）。
  const setProxyScope = (id, on) => {
    setForm((f) => ({
      ...f,
      proxy: { ...f.proxy, scopes: { ...f.proxy.scopes, [id]: on } }
    }))
  }

  const testProxy = async () => {
    setProxyTesting(true)
    setProxyResult(null)
    try {
      const r = await api.verifyProxy(form.proxy.url)
      setProxyResult(r)
      if (r.ok) toast('代理可用')
    } catch (e) {
      setProxyResult({ ok: false, verdict: e.message })
      toast(`验证失败：${e.message}`, 'err')
    } finally {
      setProxyTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await api.putSettings(form)
      // 后端在同步 magpie 代理失败时会在响应里带 warnings：不能假装完全成功
      if (res?.warnings?.length) toast(`设置已保存，但${res.warnings.join('；')}`, 'err')
      else toast('设置已保存（manager.json）')
      refresh()
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const checkShellUpdate = async () => {
    setShellChecking(true)
    try {
      // 壳子自身更新走 electron-updater；此处通过 manager API 的更新汇总取壳子（id=shell/hub 之外的条目由壳子实现方约定）
      // 用 updates/summary 里 id=hub 的 check 作为壳子更新探测的演示入口不合适，直接调用 manager 约定端点：
      const r = await api.checkUpdate('hub')
      if (r.latest && r.latest !== r.current) {
        toast(`发现壳子新版本 v${r.latest}，请到更新中心执行`, 'ok')
      } else {
        toast(`壳子已是最新（v${r.current}）`)
      }
    } catch (e) {
      toast(`检查壳子更新失败：${e.message}`, 'err')
    } finally {
      setShellChecking(false)
    }
  }

  if (loading && !data) return <Loading text="读取 manager.json…" />
  if (error && !data) return <ErrorBox error={error} onRetry={refresh} />
  if (!form) return <Empty />

  const g = form.general
  const u = form.update
  const s = form.sub2api
  const p = form.proxy
  const dirty = JSON.stringify(form) !== JSON.stringify(normalize(data))

  return (
    <>
      <div className="card section">
        <div className="section-head">
          <h2>通用</h2>
          <span className="desc">窗口行为与开机自启</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>关闭按钮行为</label>
            <select className="select" value={g.closeAction} onChange={(e) => set('general', 'closeAction', e.target.value)}>
              <option value="tray">最小化到托盘（后台保持运行）</option>
              <option value="quit">直接退出（反序停止平台）</option>
            </select>
          </div>
          <div className="field">
            <label>开机自启平台（多选）</label>
            <div className="checkbox-group" style={{ paddingTop: 6 }}>
              {PLATFORM_CHOICES.map((c) => (
                <label className="check-row" key={c.id}>
                  <input
                    type="checkbox"
                    checked={(g.autoStartPlatforms || []).includes(c.id)}
                    onChange={() => toggleAutoStartPlatform(c.id)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={!!g.autoStart} onChange={(e) => set('general', 'autoStart', e.target.checked)} />
            开机自动启动 wanneng2api
          </label>
          <label className="check-row">
            <input type="checkbox" checked={!!g.startMinimized} onChange={(e) => set('general', 'startMinimized', e.target.checked)} />
            启动时最小化（托盘）
          </label>
        </div>
      </div>

      <div className="card section">
        <div className="section-head">
          <h2>更新</h2>
          <span className="desc">远程更新检查（GitHub Releases）</span>
        </div>
        <div className="form-grid">
          <label className="check-row">
            <input type="checkbox" checked={!!u.checkOnLaunch} onChange={(e) => set('update', 'checkOnLaunch', e.target.checked)} />
            启动时自动检查更新
          </label>
          <div className="field">
            <label>GitHub Token <span className="desc">可选，避免 API rate limit</span></label>
            <input
              className="input"
              type="password"
              placeholder="ghp_…（留空则匿名限频）"
              value={u.githubToken || ''}
              onChange={(e) => set('update', 'githubToken', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card section">
        <div className="section-head">
          <h2>Sub2API 依赖</h2>
          <span className="desc">启用 sub2api 时嵌入式 PG / Redis 端口</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>PostgreSQL 端口</label>
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              value={s.pgPort ?? ''}
              onChange={(e) => set('sub2api', 'pgPort', Number(e.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label>Redis 端口</label>
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              value={s.redisPort ?? ''}
              onChange={(e) => set('sub2api', 'redisPort', Number(e.target.value) || 0)}
            />
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          默认 5433 / 6380（避开系统 5432 / 6379）。修改后需重启 sub2api 生效。
        </div>
      </div>

      <div className="card section">
        <div className="section-head">
          <h2>代理</h2>
          <span className="desc">壳出网与 magpie 流量走哪个代理</span>
        </div>
        <div className="form-grid">
          <label className="check-row">
            <input type="checkbox" checked={!!p.enabled} onChange={(e) => set('proxy', 'enabled', e.target.checked)} />
            启用代理
          </label>
          <div className="field">
            <label>代理地址</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                value={p.url || ''}
                disabled={!p.enabled}
                onChange={(e) => set('proxy', 'url', e.target.value)}
              />
              <button className="btn" disabled={proxyTesting || !p.url} onClick={testProxy}>
                {proxyTesting ? '验证中…' : '验证代理'}
              </button>
            </div>
            {proxyResult && (
              // 配色按 usable（代理隧道是否通）而不是 ok：能收到 403 说明代理是好的，
              // 不该标红吓人
              <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8, color: proxyResult.usable ? 'var(--green)' : 'var(--orange)' }}>
                {proxyResult.usable ? '✓ ' : '⚠ '}{proxyResult.verdict}
                {proxyResult.summary && (
                  <div style={{ color: 'var(--text-3)' }}>
                    走代理：{proxyResult.summary.viaProxy}{'　'}直连：{proxyResult.summary.direct}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="field">
            <label>代理范围 <span className="desc">勾选哪些流量走上面的代理</span></label>
            <div className="checkbox-group" style={{ paddingTop: 6 }}>
              {PROXY_SCOPES.map((s) => (
                <label className="check-row" key={s.id}>
                  <input
                    type="checkbox"
                    checked={!!p.scopes?.[s.id]}
                    disabled={!p.enabled}
                    onChange={(e) => setProxyScope(s.id, e.target.checked)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.9 }}>
          Node 默认不读系统代理，所以壳的更新/下载必须在这里显式开启。<br />
          「订阅流量 / 插件流量」写入 magpie 自己的 proxy / pluginProxy；<b>取消勾选会明确设为不走代理</b>——
          magpie 的空值含义是「跟随系统代理」，而系统代理可能对你的目标不通。<br />
          四个自研网关的流量不受此设置影响（它们各自的代理由自己的配置决定）。
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn primary" disabled={saving || !dirty} onClick={save}>
          {saving ? '保存中…' : dirty ? '保存设置' : '无改动'}
        </button>
        {dirty && <span style={{ fontSize: 12, color: 'var(--orange)' }}>有未保存的修改</span>}
        {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>上次刷新失败：{error.message}</span>}
      </div>

      <div className="card section">
        <div className="section-head">
          <h2>关于</h2>
        </div>
        <div className="form-grid">
          <div style={{ fontSize: 13, lineHeight: 2 }}>
            <div><b>wanneng2api</b> 统一网关平台</div>
            <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
              壳子 + 平台托管 + Hub 聚合层 · 数据接口：{apiMode === 'mock' ? 'Mock（演示）' : 'Manager API'}
            </div>
            <div style={{ color: 'var(--text-3)', fontSize: 12.5 }}>设计文档：docs/DESIGN.md</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
            <button className="btn" disabled={shellChecking} onClick={checkShellUpdate}>
              {shellChecking ? '检查中…' : '检查壳子更新'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>壳子自更新走 electron-updater（GitHub Releases）</span>
          </div>
        </div>
      </div>
    </>
  )
}

/** 归一化：保证表单所需的字段存在（dirty 比对也用它，键必须稳定） */
function normalize(raw) {
  const scopes = {}
  for (const s of PROXY_SCOPES) scopes[s.id] = !!raw.proxy?.scopes?.[s.id]
  return {
    general: {
      closeAction: raw.general?.closeAction ?? 'tray',
      autoStart: !!raw.general?.autoStart,
      startMinimized: !!raw.general?.startMinimized,
      autoStartPlatforms: Array.isArray(raw.general?.autoStartPlatforms) ? raw.general.autoStartPlatforms : []
    },
    update: {
      checkOnLaunch: !!raw.update?.checkOnLaunch,
      githubToken: raw.update?.githubToken ?? ''
    },
    proxy: {
      enabled: !!raw.proxy?.enabled,
      url: raw.proxy?.url ?? '',
      scopes
    },
    sub2api: {
      pgPort: raw.sub2api?.pgPort ?? 5433,
      redisPort: raw.sub2api?.redisPort ?? 6380
    }
  }
}
