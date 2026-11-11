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
      // 后端对没有 updater.repo 的平台返回 checked:false + reason，
      // 这不是失败，得跟真正的错误区分开。
      if (r.checked === false) {
        // 「没配远程源」与「仓库还没发 Release」都是正常状态，不是失败
        toast(`${p.name}：${r.reason || '该平台没有配置更新源'}`)
      } else if (r.latest && r.latest !== r.current) {
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
      // 只有 checked:true 且确实拿到更新的才算「有新版本」；
      // 没配远程源的平台返回 latest=null，不能拿 null!==null 之外的口径误报。
      const found = results.filter((r) => r.status === 'fulfilled'
        && r.value.checked !== false && r.value.latest && r.value.latest !== r.value.current).length
      // checked:false 现在同时表示两种情况，必须拆开统计：
      //   noRelease=true → 仓库还没发 Release（上游状态，不是失败）
      //   否则           → 没配 updater.repo（本地自研，本就不检查）
      // 早先前端只从 rejected 里数 noRelease，而后端已把 noRelease 归一成
      // 200 + checked:false，于是它们全被算进「N 个本地自研」，提示里消失。
      const skippedRes = results.filter((r) => r.status === 'fulfilled' && r.value.checked === false)
      const noRelease = skippedRes.filter((r) => r.value.noRelease === true).length
      const skipped = skippedRes.length - noRelease
      const failed = results.filter((r) => r.status === 'rejected').length
      const parts = [
        `${found} 个平台有新版本`,
        skipped ? `${skipped} 个本地自研` : '',
        noRelease ? `${noRelease} 个仓库暂无 Release` : '',
        failed ? `${failed} 个检查失败` : '',
      ].filter(Boolean)
      toast(`检查完成：${parts.join('，')}`, failed ? 'err' : 'ok')
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
                      {/* 有仓库就给出发布页入口：仓库暂无 Release 时用户能自己去看为什么 */}
                      {it.repo && (
                        <div style={{ fontSize: 11, marginTop: 2 }}>
                          <a href={`https://github.com/${it.repo}/releases`} target="_blank" rel="noreferrer"
                            style={{ color: 'var(--text-3)' }}>{it.repo}</a>
                        </div>
                      )}
                    </td>
                    <td className="num">{it.current ? `v${it.current}` : '—'}</td>
                    <td className="num">
                      {it.latest
                        ? (it.updateAvailable
                            ? <span style={{ color: 'var(--blue)', fontWeight: 700 }}>v{it.latest}</span>
                            : <span style={{ color: 'var(--text-3)' }}>v{it.latest}</span>)
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>
                      {/* 四种状态必须分开：把「仓库还没发 Release」和「网络/限流失败」
                          都染成红色「检测失败」会让用户去查网络，方向完全错。 */}
                      {it.noRelease
                        ? <span className="badge gray" title={it.checkError}>仓库暂无 Release</span>
                        : it.noAsset
                          // 有 Release 但没有匹配本平台的资产（如只发了 APK）：
                          // 不能显示「最新」，否则等于把「装不了」说成「不用装」
                          ? <span className="badge gray" title={`该 Release 没有匹配 ${it.assetPattern || '所需格式'} 的资产；现有资产：${(it.allAssets || []).join(', ') || '无'}`}>无匹配资产</span>
                          : it.checkError
                            ? <span className="badge red" title={it.checkError}>检测失败</span>
                            : !it.hasUpdater
                              ? <span className="badge gray" title="该平台没有配置 updater.repo，按本地自研维护，不存在远程版本">本地自研</span>
                              : it.updateAvailable
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

      <MagpieCoreCard />

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

/** Magpie 内核版本卡片：检测本机 CLI 版本与 GitHub 最新 release 的差异 */
function MagpieCoreCard() {
  const fetchVersion = useCallback(() => api.magpieVersion(), [])
  // 更新进行中每 3 秒轮询一次，平时不轮询
  const [pollMs, setPollMs] = useState(0)
  const { data, error, loading, refresh } = usePolling(fetchVersion, pollMs)
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)

  // 更新开始后转为轮询，等 magpie 自己跑完
  useEffect(() => {
    if (updating && data?.updating === false && data?.lastUpdate) {
      setUpdating(false)
      setPollMs(0)
      const ok = data.lastUpdate.ok
      toast(ok ? 'magpie 内核更新完成，请重启 magpie 网关生效' : `更新失败：${data.lastUpdate.message}`, ok ? 'ok' : 'err')
      refresh()
    }
  }, [data?.updating, data?.lastUpdate, updating, refresh, toast])

  const doUpdate = async () => {
    setUpdating(true)
    try {
      await api.magpieUpdate()
      toast('已开始下载并安装最新内核…')
      setPollMs(3000)
      refresh()
    } catch (e) {
      setUpdating(false)
      toast(`更新失败：${e.message}`, 'err')
    }
  }

  const recheck = async () => {
    setChecking(true)
    try {
      // usePolling.refresh() 不返回值，这里直接取一次以给出提示
      const r = await api.magpieVersion()
      refresh()
      if (r && r.hasUpdate) toast(`magpie 有新版本 v${r.latest}（当前 v${r.current}）`)
      else if (r && r.current) toast(`magpie 已是最新 v${r.current}`)
      else toast('未检测到本机 magpie 可执行文件', 'err')
    } catch (e) {
      toast(`检测失败：${e.message}`, 'err')
    } finally {
      setChecking(false)
    }
  }

  // 未安装时的一键安装：后台下载，这里轮询进度
  const [inst, setInst] = useState(null)
  const [installing, setInstalling] = useState(false)
  // 挂载时先取一次，拿到安装目录（未安装时引导文案要用）
  useEffect(() => {
    api.magpieInstallStatus().then(setInst).catch(() => {})
  }, [])
  useEffect(() => {
    if (!installing) return
    const t = setInterval(async () => {
      try {
        const s = await api.magpieInstallStatus()
        setInst(s)
        const st = s?.progress?.status
        if (s?.installed || st === 'failed' || st === 'done') {
          setInstalling(false)
          refresh()
          if (s?.installed) toast('magpie 已安装，正在启动控制台…')
          else toast(s?.progress?.message || '安装失败', 'err')
        }
      } catch { /* 轮询失败忽略，下轮再试 */ }
    }, 1500)
    return () => clearInterval(t)
  }, [installing, refresh, toast])

  const doInstall = async () => {
    setInstalling(true)
    try {
      await api.magpieInstall()
      toast('开始下载 magpie…')
    } catch (e) {
      setInstalling(false)
      toast(`安装启动失败：${e.message}`, 'err')
    }
  }

  const missing = data && !data.current   // 没有本机版本 = 未安装

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          内核版本
          <span className="badge blue">magpie</span>
        </span>
        <button className="btn sm" disabled={checking} onClick={recheck}>
          {checking ? '检测中…' : '检查内核更新'}
        </button>
      </div>

      {loading && !data && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>检测中…</div>}
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>检测失败：{error.message}</div>}

      {data && (
        <>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>组件</th><th>本机版本</th><th>最新版本</th><th>状态</th><th style={{ textAlign: 'right' }}>操作</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><b>magpie 内核</b>
                    {!data.binary && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>未找到可执行文件</div>}
                  </td>
                  <td className="num">{data.current ? `v${data.current}` : '—'}</td>
                  <td className="num">{data.latest ? <span style={{ color: data.hasUpdate ? 'var(--blue)' : 'var(--text-3)', fontWeight: data.hasUpdate ? 700 : 400 }}>v{data.latest}</span> : '—'}</td>
                  <td>
                    {!data.current
                      ? <span className="badge gray">未安装</span>
                      : data.hasUpdate
                        ? <span className="badge orange">有新版</span>
                        : <span className="badge green">最新</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {missing && !installing && (
                      <button className="btn sm primary" onClick={doInstall}>一键安装</button>
                    )}{' '}
                    {installing && <span className="badge blue">安装中…</span>}
                    {!missing && data.hasUpdate && !updating && (
                      <button className="btn sm primary" onClick={doUpdate}>立即更新内核</button>
                    )}{' '}
                    {!missing && (updating || data.updating)
                      ? <span className="badge blue">更新中…</span>
                      : data.releaseUrl
                        ? <a className="btn sm ghost" href={data.releaseUrl} target="_blank" rel="noreferrer">发布页</a>
                        : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* 安装进度 */}
          {inst?.progress && ['resolving', 'downloading'].includes(inst.progress.status) && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>{inst.progress?.message || '下载中…'}</span>
                {inst.progress?.total > 0 && (
                  <span style={{ color: 'var(--text-3)' }}>
                    {(inst.progress.received / 1048576).toFixed(1)} / {(inst.progress.total / 1048576).toFixed(1)} MB
                  </span>
                )}
              </div>
              <div className="progress">
                <div className="bar" style={{
                  width: inst.progress?.total
                    ? `${Math.round((inst.progress.received / inst.progress.total) * 100)}%`
                    : '15%',
                }} />
              </div>
            </div>
          )}

          {missing ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 10, lineHeight: 1.8 }}>
              未检测到 magpie 内核。它是约 79MB 的独立程序，不随安装包分发——
              点「一键安装」会自动下载到{' '}
              <span className="mono">{inst?.target || '%APPDATA%\\wanneng2api\\magpie'}</span>
              ，装好后插件市场、登录与内嵌控制台都会自动可用。
              <br />
              也可以自行安装（<a href="https://usemagpie.ai" target="_blank" rel="noreferrer">usemagpie.ai</a>），
              或把 <span className="mono">magpie.exe</span> 放进上面的目录。
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
              magpie 内核以独立应用方式安装与自更新，管理台只检测版本、不代为升级。
              发布源：<span className="mono">yetone/magpie-releases</span>
              {data.checkedAt ? ` · 检测于 ${fmtAgo(data.checkedAt)}` : ''}
            </div>
          )}
        </>
      )}
    </div>
  )
}
