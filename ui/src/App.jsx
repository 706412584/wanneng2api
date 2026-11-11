import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { apiMode, apiBase, pingManager } from './api/client'
import { useTheme } from './hooks/useTheme'
import { ToastProvider } from './components/Toast'
import { BusyProvider, ConfirmProvider } from './components/Busy'
import Overview from './pages/Overview'
import Platforms from './pages/Platforms'
import Updates from './pages/Updates'
import Hub from './pages/Hub'
import Logs from './pages/Logs'
import Settings from './pages/Settings'

const NAV = [
  { to: '/overview', ico: '▤', label: '概览', group: '工作区' },
  { to: '/platforms', ico: '▦', label: '平台管理', group: null },
  { to: '/updates', ico: '⟳', label: '更新中心', group: null },
  { to: '/hub', ico: '⇄', label: 'Hub 聚合', group: '系统模块' },
  { to: '/logs', ico: '▥', label: '日志', group: null },
  { to: '/settings', ico: '⚙', label: '设置', group: null }
]

const TITLES = {
  '/overview': '概览',
  '/platforms': '平台管理',
  '/updates': '更新中心',
  '/hub': 'Hub 聚合层',
  '/logs': '日志',
  '/settings': '设置'
}

export default function App() {
  const { mode, cycle } = useTheme()
  const location = useLocation()
  const [managerUp, setManagerUp] = useState(null) // null=探测中
  const [probeAt, setProbeAt] = useState(0)

  // Manager API 可达性探测：10s 周期
  const probe = useCallback(async () => {
    const ok = await pingManager()
    setManagerUp(ok)
    setProbeAt(Date.now())
    return ok
  }, [])

  useEffect(() => {
    probe()
    const t = setInterval(probe, 10000)
    return () => clearInterval(t)
  }, [probe])

  const themeIcon = mode === 'auto' ? '◐' : mode === 'light' ? '☀' : '☾'
  const themeLabel = mode === 'auto' ? '跟随系统' : mode === 'light' ? '浅色' : '深色'

  return (
    <ToastProvider>
      <ConfirmProvider>
      <BusyProvider>
      <TitleBar />
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-logo">万</span>
            <span>wanneng2api</span>
          </div>
          {NAV.map((item, i) => (
            <span key={item.to} style={{ display: 'contents' }}>
              {item.group && <div className="group-label">{item.group}</div>}
              <NavLink to={item.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <span className="ico">{item.ico}</span>
                <span>{item.label}</span>
              </NavLink>
            </span>
          ))}
          <div className="sidebar-foot">
            <button className="nav-item" onClick={cycle} title="切换主题">
              <span className="ico">{themeIcon}</span>
              <span>{themeLabel}</span>
            </button>
            <div className="group-label" style={{ padding: '2px 10px' }}>
              {apiMode === 'mock' ? '● Mock 模式' : '● Live 模式'} · {apiBase.replace('http://', '')}
            </div>
          </div>
        </aside>

        <div className="main-col">
          {managerUp === false && (
            <div className="banner">
              <span>⚠</span>
              <span>
                Manager API 不可达（{apiBase}）。请确认壳子已启动；当前展示的可能为 mock 演示数据或缓存数据。
              </span>
              <button className="btn sm" onClick={probe}>重新检测</button>
            </div>
          )}
          <header className="topbar">
            <h1>{TITLES[location.pathname] || 'wanneng2api'}</h1>
            <div className="spacer" />
            {managerUp != null && (
              <span className={`state-pill ${managerUp ? 'healthy' : 'unhealthy'}`}>
                <span className={`dot ${managerUp ? 'healthy' : 'unhealthy'}`} style={{ width: 7, height: 7 }} />
                Manager {managerUp ? '在线' : '离线'}
              </span>
            )}
          </header>
          <main className="content">
            <div className="content-inner">
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/platforms" element={<Platforms />} />
                <Route path="/updates" element={<Updates />} />
                <Route path="/hub" element={<Hub />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Overview />} />
              </Routes>
            </div>
          </main>
        </div>
      </div>
      </BusyProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}

/**
 * 自绘标题栏。
 * Electron 主窗口是 frame:false（Windows 下 titleBarStyle:hidden 会把系统按钮
 * 一起拿掉），所以最小化/最大化/关闭要自己画。
 * 浏览器里（非桌面）整个条隐藏，不影响 Web 版使用。
 */
function TitleBar() {
  const shell = typeof window !== 'undefined' ? window.wannengShell : null
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    if (!shell) return
    document.documentElement.classList.add('has-titlebar')
    shell.isMaximized().then(setMaxed).catch(() => {})
    const off = shell.onMaximizeChange(setMaxed)
    return () => {
      document.documentElement.classList.remove('has-titlebar')
      if (off) off()
    }
  }, [shell])

  if (!shell) return null

  return (
    <div className="titlebar">
      {/* 左侧留白 + 可拖动区：brand 已显示在侧栏，这里只放应用名 */}
      <div className="titlebar-drag">
        <span className="titlebar-title">Wanneng2API</span>
      </div>
      <div className="titlebar-actions">
        <button className="tb-btn" title="最小化" onClick={() => shell.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button className="tb-btn" title={maxed ? '还原' : '最大化'} onClick={() => shell.toggleMaximize()}>
          {maxed
            ? <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" /><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" /></svg>
            : <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>}
        </button>
        <button className="tb-btn tb-close" title="关闭" onClick={() => shell.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </div>
  )
}
