import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { apiMode, apiBase, pingManager } from './api/client'
import { useTheme } from './hooks/useTheme'
import { ToastProvider } from './components/Toast'
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
    </ToastProvider>
  )
}
