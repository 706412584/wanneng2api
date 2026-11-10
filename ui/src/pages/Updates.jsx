// 更新中心：版本对照表 + 一键检查全部 + 单平台检查/立即更新 + 更新进度 + 回滚告警条
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Empty, ErrorBox, Loading, StateDot, STATE_TEXT } from '../components/Bits'
import { fmtAgo } from '../utils/format'

export default function Updates() {
  const fetchSummary = useCallback(() => api.updatesSummary(), [])
  const fetchPlatforms = useCallback(() => api.listPlatforms(), [])
  const sum = usePolling(fetchSummary, 8000)
  const pf = usePolling(fetchPlatforms, 3000) // 高频以捕捉 updating 状态
  const toast = useToast()

  const [checking, setChecking] = useState({}) // id -> true
  const [applying, setApplying] = useState({})
  const [checkAllBusy, setCheckAllBusy] = useState(false)
  const [rollbackAlert, setRollbackAlert] = useState(null)

  const platforms = pf.data || []
  const items = sum.data?.items || []
  const updating = platforms.filter((p) => p.state === 'updating')
  const anyUpdating = updating.length > 0

  const checkOne = async (p) => {
    setChecking((c) => ({ ...c, [p.id]: true }))
    try {
      const r = await api.checkUpdate(p.id)
      if (r.latest && r.latest !== r.current) {
        toast(`${p.name}：发现新版本 v${r.latest}（当前 v${r.current}）`)
      } else {
        toast(`${p.name}：已是最新 v${r.current}`)
      }
      sum.refresh()
      pf.refresh()
    } catch (e) {
      toast(`${p.name} 检查更新失败：${e.message}`, 'err')
    } finally {
      setChecking((c) => { const n = { ...c }; delete n[p.id]; return n })
    }
  }

  const checkAll = async () => {
    setCheckAllBusy(true)
    try {
      const results = await Promise.allSettled(platforms.map((p) => api.checkUpdate(p.id)))
      const found = results.filter((r) => r.status === 'fulfilled' && r.value.latest !== r.value.current).length
      const failed = results.filter((r) => r.status === 'rejected').length
      toast(`检查完成：${found} 个平台有新版本${failed ? `，${failed} 个检查失败` : ''}`, failed ? 'err' : 'ok')
      sum.refresh()
      pf.refresh()
    } finally {
      setCheckAllBusy(false)
    }
  }

  const applyOne = async (p) => {
    setApplying((a) => ({ ...a, [p.id]: true }))
    try {
      await api.applyUpdate(p.id)
      toast(`${p.name} 更新已开始，状态转为「更新中」`)
    } catch (e) {
      toast(`${p.name} 更新下发失败：${e.message}`, 'err')
    } finally {
      setApplying((a) => { const n = { ...a }; delete n[p.id]; return n })
    }
  }

  // 更新失败告警：监控 state=error 且 lastError 含「更新」或「回滚」
  useEffect(() => {
    const failed = platforms.find((p) => ['error', 'unhealthy'].includes(p.state) && p.lastError && /更新|回滚/.test(p.lastError))
    if (failed) setRollbackAlert({ id: failed.id, name: failed.name, msg: failed.lastError, at: Date.now() })
  }, [platforms.map((p) => `${p.id}:${p.state}:${p.lastError}`).join('|')])

  if (sum.loading && !sum.data) return <Loading text="加载版本信息…" />
  if (sum.error && !sum.data) return <ErrorBox error={sum.error} onRetry={sum.refresh} />

  return (
    <>
      {rollbackAlert && (
        <div className="alert-bar red">
          <span>⚠</span>
          <span style={{ flex: 1 }}>
            <b>{rollbackAlert.name}</b>：{rollbackAlert.msg} —— 已自动回滚到旧版本，请检查更新包或稍后重试。
          </span>
          <button className="btn sm" onClick={() => setRollbackAlert(null)}>知道了</button>
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            版本对照
            <span className="sub">{sum.data?.checkedAt ? `上次检查 ${fmtAgo(sum.data.checkedAt)}` : '尚未检查'}</span>
          </span>
          <button className="btn primary" disabled={checkAllBusy || anyUpdating || !platforms.length} onClick={checkAll}>
            {checkAllBusy ? '检查中…' : '一键检查全部'}
          </button>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>平台</th>
                <th>当前版本</th>
                <th>最新版本</th>
                <th>状态</th>
                <th>运行状态</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const plat = platforms.find((p) => p.id === it.id)
                const isUpdating = plat?.state === 'updating'
                const pct = isUpdating ? Math.min(95, ((Date.now() % 8000) / 8000) * 100) : null
                return (
                  <tr key={it.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <StateDot state={plat?.state || 'stopped'} size={7} />
                        <b>{it.name}</b>
                      </div>
                      {it.notes && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, maxWidth: 340 }}>{it.notes}</div>}
                    </td>
                    <td className="num">v{it.current}</td>
                    <td className="num">{it.updateAvailable ? <span style={{ color: 'var(--blue)', fontWeight: 700 }}>v{it.latest}</span> : <span style={{ color: 'var(--text-3)' }}>v{it.latest}</span>}</td>
                    <td>
                      {it.updateAvailable
                        ? <span className="badge orange">有新版</span>
                        : <span className="badge green">最新</span>}
                    </td>
                    <td>{plat ? <span className={`state-pill ${plat.state}`}>{STATE_TEXT[plat.state]}</span> : '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn sm"
                        disabled={!!checking[it.id] || isUpdating || anyUpdating && false}
                        onClick={() => checkOne(plat || { id: it.id, name: it.name })}
                      >
                        {checking[it.id] ? '检查中…' : '检查更新'}
                      </button>{' '}
                      <button
                        className="btn sm primary"
                        disabled={!it.updateAvailable || isUpdating || !plat || ['starting', 'updating'].includes(plat.state)}
                        onClick={() => applyOne(plat)}
                      >
                        {isUpdating ? '更新中…' : applying[it.id] ? '下发中…' : '立即更新'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!items.length && <Empty icon="⟳" text="暂无版本数据，点击「一键检查全部」开始" />}
      </div>

      {anyUpdating && (
        <div className="card">
          <div className="card-title">更新进度</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {updating.map((p) => (
              <div key={p.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5 }}>
                  <span><b>{p.name}</b> 正在下载/替换二进制并重启验证…</span>
                  <span style={{ color: 'var(--text-3)' }}>停止 → 备份 → 覆盖 → 健康验证</span>
                </div>
                <div className="progress"><div className="bar updating" style={{ width: '100%', backgroundSize: '40px 7px' }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">更新策略说明 <span className="sub">docs/DESIGN.md §7</span></div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.9 }}>
          更新期间平台状态为「更新中」，启停操作被禁用。流程：下载（.part 防半包）→ 停止平台 →
          备份当前二进制/目录 → 覆盖（不动 config / auths / data）→ 重启并健康验证；
          60s 内未通过健康验证则<b style={{ color: 'var(--orange)' }}> 自动回滚 </b>并在顶部显示告警条。备份保留最近 3 份。
        </div>
      </div>
    </>
  )
}
