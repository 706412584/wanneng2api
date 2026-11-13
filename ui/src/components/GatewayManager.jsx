// 自研网关的原生管理抽屉（WorkBuddy / CodeArts / Loomy / Lingxi）
// 与插件抽屉同构：只调壳的 /api/platforms/:id/panel，从不 iframe 内核控制台。
// 各家能力不同：分区按后端返回的 capabilities 动态出现，无能力的直接不渲染。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useToast } from './Toast'
import { useConfirm } from './Busy'
import { ErrorBox, Loading } from './Bits'
import { fmtNum, fmtAgo } from '../utils/format'

/** 北京时间的「今天」，与网关侧签到判定同一口径 */
const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

/** 秒数 → 人话 */
function fmtSec(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 60) return `${Math.round(n)} 秒`
  if (n < 3600) return `${Math.round(n / 60)} 分钟`
  return `${(n / 3600).toFixed(1)} 小时`
}

/** 通用的字节数/计数格式化；null 显示为 —，绝不编造 0 */
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? fmtNum(v) : '—')

/** 成功率 0–1 → 百分比 */
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—')

/**
 * 每个平台的展示能力。后端 capabilities 是权威，这里只映射中文标签与顺序。
 * 后端没给的分区不出现。
 */
const SECTION_LABEL = {
  accounts: '账号',
  groups: '分组',
  stats: '统计',
  schedule: '排程',
  logs: '日志',
  checkin: '签到',
  credits: '积分',
  points: '积分',
  usage: '用量',
  lan: '局域网',
}

export default function GatewayManager({ platform, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('accounts')
  const [busy, setBusy] = useState('')          // 单个账号动作的忙碌标记
  const [logs, setLogs] = useState(null)
  const [logsError, setLogsError] = useState(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [query, setQuery] = useState('')
  const generation = useRef(0)
  const dialogRef = useRef(null)
  const toast = useToast()
  const confirm = useConfirm()

  const id = platform.id
  const caps = data?.capabilities || []
  const accounts = data?.accounts?.accounts || []
  const platformName = data?.name || platform.name || id

  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try {
      const result = await api.gatewayPanel(id)
      if (generation.current !== current) return
      setData(result)
      setError(null)
    } catch (e) {
      if (generation.current === current) setError(e)
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    generation.current += 1
    setData(null)
    setError(null)
    setLogs(null)
    setLogsError(null)
    setQuery('')
    // 第一个分区：优先账号
    setTab('accounts')
    refresh()
    // 卸载或切换平台后丢弃在途结果
    return () => { generation.current += 1 }
  }, [id, refresh])

  // 焦点锁与 Esc：与插件抽屉同一套行为
  useEffect(() => {
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKey = (e) => {
      // 走 ref 而不是直接读 busy：这个 handler 只注册一次（[] 依赖），
      // 闭包里的 busy 永远是初始的 ''，操作进行中按 Esc 会照常关面板。
      if (e.key === 'Escape') { e.stopPropagation(); leaveRef.current() }
      if (e.key !== 'Tab') return
      const list = [...(dialogRef.current?.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ) || [])].filter((node) => node.getClientRects().length)
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === document.body)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      previous?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const leave = () => { if (busy) return; onChanged?.(); onClose() }
  // 给只注册一次的 keydown handler 一个始终最新的 leave
  const leaveRef = useRef(leave)
  leaveRef.current = leave

  /** 执行一个受限动作：成功后统一刷新视图 */
  const act = async (label, action, body = {}) => {
    if (busy) return null
    setBusy(action + ':' + (body.id || ''))
    try {
      const result = await api.gatewayPanelAction(id, action, body)
      toast(`${label}已完成`)
      await refresh()
      onChanged?.()
      return result
    } catch (e) {
      setError(e)
      toast(`${label}失败：${e.message}`, 'err')
      return null
    } finally {
      setBusy('')
    }
  }

  const loadLogs = async () => {
    if (logsLoading) return
    setLogsLoading(true)
    setLogsError(null)
    try {
      const result = await api.gatewayLogs(id, 300)
      setLogs(result.lines || [])
    } catch (e) {
      setLogsError(e)
    } finally {
      setLogsLoading(false)
    }
  }

  // 首次切到日志分区时自动加载一次
  useEffect(() => {
    if (tab === 'logs' && !logs && !logsLoading && !logsError) loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const isBusy = (action, accountId) => busy === `${action}:${accountId}`

  // ── 账号行：各家字段不同，统一用同一套断言渲染 ──

  const accountToggle = async (account) => {
    const enabling = !account.enabled
    await act(enabling ? '启用账号' : '暂停账号', 'account-toggle', { id: account.id, enabled: enabling })
  }

  const accountTest = async (account) => {
    const result = await act('测试连接', 'account-test', { id: account.id })
    if (result) {
      toast(result.ok
        ? `连接正常${result.latencyMs ? `（${result.latencyMs} ms）` : ''}`
        : `连接失败：${result.message || '网关未返回原因'}`,
        result.ok ? 'ok' : 'err')
    }
  }

  const accountRemove = async (account) => {
    if (!await confirm(`将移除账号 ${account.name || account.id}。移除后需要重新登录才能恢复，是否继续？`,
      { title: '移除账号', danger: true, okText: '移除' })) return
    await act('移除账号', 'account-remove', { id: account.id })
  }

  const accountCheckin = async (account) => {
    const who = account.name || account.id
    const result = await act(`签到 ${who}`, 'checkin', { id: account.id })
    if (!result) return
    // 判定顺序按「确定性字段」走，不做文案匹配：
    //   enterprise → 企业号根本没有签到体系（后端明确返回 enterprise:true）
    //   already    → 幂等拒绝，今天确实签过了
    //   ok && done → 真签到成功
    //   ok && !done→ 后端说成功但没落签到标记（例如只刷新了额度）→ 不能报成功
    if (result.enterprise) {
      toast(`${who} 是企业账号，没有签到体系（仅刷新额度）`, 'err')
    } else if (result.already) {
      toast(`${who} 今日已签到`, 'ok')
    } else if (result.ok && result.done) {
      toast(`${who} 签到成功${result.balance != null ? `，余额 ${fmtNum(result.balance)}` : ''}`)
    } else if (result.ok) {
      toast(`${who} 未记录到签到成功${result.message ? `：${result.message}` : '（今日可能未签到）'}`, 'err')
    } else {
      toast(`${who} 签到未成功：${result.message || '未知原因'}`, 'err')
    }
  }

  const accountExtras = async (account, action, label) => {
    await act(label, action, { id: account.id })
  }

  /** 账号是否今日已签（各家字段名不同，统一收敛） */
  const checkinDone = (a) => {
    if (a.checkinDone) return true
    if (a.lastCheckinDay === todayCN()) return true
    if (a.checkin?.day === todayCN()) return true
    return false
  }

  const tabs = caps.length ? caps.filter((c) => SECTION_LABEL[c]) : ['accounts']

  return (
    <div className="plugin-manager-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) leave() }}>
      <section className="plugin-manager" role="dialog" aria-modal="true" aria-labelledby="gw-manager-title"
        tabIndex={-1} ref={dialogRef}>
        <header className="plugin-manager-head">
          <div>
            <span className="plugin-manager-eyebrow">网关管理 · {platformName}</span>
            <h2 id="gw-manager-title">{platformName}</h2>
            <div className="plugin-manager-package mono">
              {id} · 127.0.0.1:{data?.port ?? platform.port}
            </div>
            {(data?.install?.workDir || data?.install?.entry) && (
              <div className="plugin-manager-package mono" title="本机安装路径">
                {data.install.workDir || '—'}
                {data.install.entry ? ` · ${data.install.entry}` : ''}
              </div>
            )}
          </div>
          <button className="btn ghost" onClick={leave} disabled={!!busy} aria-label="关闭网关管理">关闭</button>
        </header>

        <nav className="plugin-manager-tabs" role="tablist" aria-label="网关管理分类">
          {tabs.map((tid) => (
            <button key={tid} role="tab" id={'gwtab-' + tid} aria-selected={tab === tid}
              aria-controls="gw-panel" className={tab === tid ? 'active' : ''}
              onClick={() => setTab(tid)}>{SECTION_LABEL[tid]}</button>
          ))}
        </nav>

        <div className="plugin-manager-body" id="gw-panel" role="tabpanel" aria-labelledby={'gwtab-' + tab}>
          {loading && !data
            ? <Loading text="读取网关状态…" />
            : error && !data ? <ErrorBox error={error} onRetry={refresh} />
            : data && <>
              {error && <div className="plugin-manager-error" role="alert">{error.message}</div>}

              {tab === 'accounts' && (
                <AccountsSection
                  data={data} accounts={accounts} query={query} setQuery={setQuery}
                  busy={busy} isBusy={isBusy}
                  onToggle={accountToggle} onTest={accountTest} onRemove={accountRemove}
                  onCheckin={accountCheckin} onExtras={accountExtras}
                  checkinDone={checkinDone}
                />
              )}
              {tab === 'groups' && <GroupsSection data={data} />}
              {tab === 'stats' && <StatsSection data={data} />}
              {tab === 'schedule' && <ScheduleSection data={data} onRun={(task) => act('执行排程', 'checkin', { task })} busy={busy} />}
              {tab === 'checkin' && (
                <CheckinSection data={data} accounts={accounts} busy={busy} isBusy={isBusy}
                  checkinDone={checkinDone} onCheckin={accountCheckin}
                  onRunAll={() => act('全量签到', 'checkin')}
                  onCheckinAll={() => act('一键签到', 'checkin-all')} />
              )}
              {tab === 'credits' && <CreditsSection data={data} accounts={accounts} busy={busy} isBusy={isBusy} onExtras={accountExtras} />}
              {tab === 'points' && <PointsSection data={data} />}
              {tab === 'usage' && <UsageSection data={data} />}
              {tab === 'lan' && (
                <LanSection
                  data={data} busy={busy}
                  onChange={(enabled) => act(enabled ? '开放局域网访问' : '关闭局域网访问', 'lan-set', { enabled })}
                />
              )}
              {tab === 'logs' && (
                <LogsSection lines={logs} error={logsError} loading={logsLoading} onReload={loadLogs} />
              )}
            </>}
        </div>

        <footer className="plugin-manager-foot">
          <span>{data ? `${accounts.length} 个账号` : '仅管理本机这一个网关'}</span>
          <button className="btn sm" disabled={loading} onClick={refresh}>刷新状态</button>
        </footer>
      </section>
    </div>
  )
}

// ── 账号 ──

function AccountsSection({ data, accounts, query, setQuery, busy, isBusy, onToggle, onTest, onRemove, onCheckin, onExtras, checkinDone }) {
  const q = query.trim().toLowerCase()
  const shown = q
    ? accounts.filter((a) => [a.name, a.id, a.user, a.masked, a.note, a.region].some((v) => v && String(v).toLowerCase().includes(q)))
    : accounts
  // WorkBuddy 的签到是整任务（一次覆盖所有 global 账号），没有逐账号签到端点，
  // 所以账号行不出现签到按钮，统一在「签到」分区里跑。
  const canCheckin = (data.capabilities || []).includes('checkin') && data.id !== 'workbuddy'
  const canTest = data.id === 'workbuddy'

  return (
    <>
      <div className="plugin-manager-section-title">
        <h3>账号</h3>
        <span className="sub">{accounts.length} 个</span>
      </div>
      {accounts.length > 6 && (
        <div className="plugin-model-toolbar">
          <input className="input" aria-label="搜索账号" placeholder="搜索账号 / 备注…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {!accounts.length && (
        <div className="plugin-manager-empty">
          该网关当前没有账号。请先通过上方「打开面板」进入其自带控制台完成登录，
          或在该网关的工作目录导入凭证；本面板只做管理，不采集账号。
        </div>
      )}
      <div className="plugin-account-list">
        {shown.map((a) => {
          const signed = checkinDone(a)
          return (
            <article className="plugin-account" key={a.id}>
              <div className="plugin-account-info">
                <b>{a.name}</b>
                <span className="sub mono">{a.masked || a.user || a.id}</span>
                <span className="sub">{accountDetail(a)}</span>
              </div>
              <span className={`badge ${a.enabled ? 'green' : 'gray'}`}>
                {a.enabled ? (a.cooling ? '冷却中' : '启用中') : '已停用'}
              </span>
              {a.expired && <span className="badge red">已过期</span>}
              {a.paused && <span className="badge orange">暂停选号</span>}
              {a.banned && <span className="badge red">已封禁</span>}
              {canCheckin && (
                <span className={`badge ${signed ? 'green' : 'gray'}`}>{signed ? '今日已签到' : '今日未签到'}</span>
              )}
              <div className="plugin-account-actions">
                <button className="btn sm" disabled={!!busy}
                  onClick={() => onToggle(a)}>{a.enabled ? '停用' : '启用'}</button>
                {canTest && (
                  <button className="btn sm ghost" disabled={!!busy} onClick={() => onTest(a)}>
                    {isBusy('account-test', a.id) ? '测试中…' : '测试连接'}
                  </button>
                )}
                {canCheckin && !signed && (
                  <button className="btn sm" disabled={!!busy || a.enterprise || !a.enabled}
                    title={a.enterprise ? '企业账号没有签到体系' : !a.enabled ? '账号已停用' : ''}
                    onClick={() => onCheckin(a)}>
                    {isBusy('checkin', a.id) ? '签到中…' : '签到'}
                  </button>
                )}
                {data.id === 'codearts' && (
                  <>
                    <button className="btn sm ghost" disabled={!!busy}
                      onClick={() => onExtras(a, 'account-clear-cooldown', '清冷却')}>清冷却</button>
                    <button className="btn sm ghost" disabled={!!busy}
                      onClick={() => onExtras(a, 'credits-refresh', '刷新额度')}>刷新额度</button>
                    <button className="btn sm ghost" disabled={!!busy}
                      onClick={() => onExtras(a, 'account-note', '更新备注')}>备注</button>
                  </>
                )}
                {data.id === 'loomy' && (
                  <button className="btn sm ghost" disabled={!!busy}
                    onClick={() => onExtras(a, 'account-check', '账号体检')}>体检</button>
                )}
                {data.id === 'lingxi' && (
                  <>
                    <button className="btn sm ghost" disabled={!!busy}
                      onClick={() => onExtras(a, 'balance-refresh', '刷新额度')}>刷新额度</button>
                    <button className="btn sm ghost" disabled={!!busy}
                      onClick={() => onExtras(a, 'account-pause', '暂停选号')}>{a.paused ? '恢复选号' : '暂停选号'}</button>
                  </>
                )}
                <button className="btn sm ghost" disabled={!!busy} onClick={() => onRemove(a)}>移除</button>
              </div>
            </article>
          )
        })}
      </div>
      {!!accounts.length && !shown.length && <div className="plugin-manager-empty">没有匹配的账号</div>}
    </>
  )
}

/** 账号副标题：各家有用信息不同，只渲染确定存在的字段 */
function accountDetail(a) {
  const parts = []
  if (a.region) parts.push(`区域 ${a.region}`)
  if (a.note) parts.push(a.note)
  if (a.credits != null) parts.push(`积分 ${fmtNum(a.credits)}`)
  if (a.available != null) parts.push(`可用 ${fmtNum(a.available)}`)
  if (a.requests != null && a.requests > 0) parts.push(`请求 ${fmtNum(a.requests)}`)
  if (a.errCount > 0) parts.push(`错误 ${a.errCount}`)
  if (a.cooldownLeft > 0) parts.push(`冷却剩余 ${fmtSec(a.cooldownLeft)}`)
  if (a.sessionDaysLeft != null) parts.push(`会话剩 ${a.sessionDaysLeft} 天`)
  if (a.tokenRemaining) parts.push(`token ${a.tokenRemaining}`)
  if (a.expiresAt) parts.push(`到期 ${String(a.expiresAt).slice(0, 10)}`)
  // fmtAgo 收的是毫秒时间戳；解析不出来就不显示，避免出现 "NaN天前"
  if (a.lastSuccess) {
    const t = Date.parse(a.lastSuccess)
    if (Number.isFinite(t)) parts.push(`末次成功 ${fmtAgo(t)}`)
  }
  if (a.lastError) parts.push(`最近错误 ${a.lastError}`)
  return parts.join(' · ')
}

// ── 其它分区 ──

/**
 * 签到分区。
 *  - WorkBuddy：签到是排程任务（一次覆盖所有 global 账号），只提供「立即执行」；
 *  - 其它三家：逐账号签到，按账号显示今日状态，并额外提供「一键签到」。
 */
function CheckinSection({ data, accounts, busy, isBusy, checkinDone, onCheckin, onRunAll, onCheckinAll }) {
  const today = todayCN()
  const isTask = data.id === 'workbuddy'
  const signed = accounts.filter((a) => checkinDone(a)).length
  const task = (data.schedule?.tasks || []).find((t) => t.key === 'checkin')

  if (isTask) {
    return (
      <>
        <div className="plugin-manager-section-title"><h3>签到</h3>
          <span className="sub">{task?.enabled ? '自动签到已启用' : '自动签到未启用'}</span>
        </div>
        <div className="plugin-manager-empty" style={{ textAlign: 'left' }}>
          该网关的签到按<b>排程任务</b>执行：一次覆盖全部 global 账号，不能对单个账号下指令。
          {task && (
            <>
              <br />运行时间：{task.hours?.length ? task.hours.map((h) => `${h}:00`).join(' / ') : '—'}
              {task.nextRun ? ` · 下次 ${String(task.nextRun).replace('T', ' ').slice(0, 16)}` : ''}
              {task.lastRun ? ` · 上次 ${String(task.lastRun).replace('T', ' ').slice(0, 16)}` : ''}
            </>
          )}
        </div>
        <div className="plugin-manager-save">
          <span className="sub">立即执行可能会与正在运行的排程冲突；网关会拒绝并返回提示。</span>
          <button className="btn primary" disabled={!!busy} onClick={onRunAll}>
            {busy ? '执行中…' : '立即执行签到任务'}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="plugin-manager-section-title"><h3>签到</h3>
        <span className="sub">{signed} / {accounts.length} 个账号今日已签</span>
      </div>
      {!accounts.length && <div className="plugin-manager-empty">该网关当前没有账号，无法签到。</div>}
      <div className="plugin-checkin-list">
        {accounts.map((a) => {
          const done = checkinDone(a)
          return (
            <article className="plugin-checkin" key={a.id}>
              <div className="plugin-checkin-info">
                <b>{a.name}</b>
                <span className="sub mono">{a.masked || a.user || a.id}</span>
                <span className="sub">
                  {a.enterprise ? '企业账号无签到体系' : done ? `今日已签到（${today}）` : '今日未签到'}
                  {a.dailyBalance != null ? ` · 每日余额 ${fmtNum(a.dailyBalance)}` : ''}
                </span>
              </div>
              <button className="btn sm primary"
                disabled={!!busy || done || a.enterprise || !a.enabled}
                title={a.enterprise ? '企业账号不支持签到' : done ? '今日已签到' : ''}
                onClick={() => onCheckin(a)}>
                {isBusy('checkin', a.id) ? '签到中…' : done ? '今日已签到' : '签到'}
              </button>
            </article>
          )
        })}
      </div>
      {/* 一键签到：逐号点一遍对几十个账号不现实。后端按各网关能力实现
          （CodeArts 一次调用覆盖全部、Lingxi 触发内核全量任务、
           Loomy 在壳内并发逐号签到）。 */}
      {!!accounts.length && (
        <div className="plugin-manager-save">
          <span className="sub">一键签到会对该网关所有已启用账号执行签到，已在今日签到的账号会被跳过。</span>
          <button className="btn primary" disabled={!!busy} onClick={onCheckinAll}>
            {busy === 'checkin-all:' ? '签到中…' : '一键签到'}
          </button>
        </div>
      )}
    </>
  )
}

/**
 * 局域网访问：改网关 config.json 里的监听地址（只改 host，端口不动）。
 *
 * 各家配置字段不同，但含义相同：
 *   workbuddy / codearts / lingxi → listen（":7863" 或 "127.0.0.1:7863"）
 *   loomy                          → host + port
 * 后端已把差异抹平，这里只呈现「开 / 关」。
 */
function LanSection({ data, busy, onChange }) {
  const lan = data.lan || {}
  const ip = lan.lanIp || ''
  const hasError = !!lan.error
  const enabled = !!lan.enabled
  const port = lan.port || data.port
  const lanUrl = ip ? `http://${ip}:${port}` : ''
  const busyHere = busy === 'lan-set:'
if (hasError) {
    return (
      <>
        <div className="plugin-manager-section-title"><h3>局域网访问</h3></div>
        <div className="plugin-manager-error" role="alert">读取监听配置失败：{lan.error}</div>
        <p className="sub" style={{ marginTop: 12 }}>
          常见原因：该网关的 config.json 不存在或格式损坏。
        </p>
      </>
    )
  }

  return (
    <>
      <div className="plugin-manager-section-title">
        <h3>局域网访问</h3>
        <span className={`badge ${enabled ? 'orange' : 'green'}`}>{enabled ? '已开放' : '仅本机'}</span>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <label className="check-row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox" checked={enabled} disabled={busyHere || !!lan.overriddenBy}
            onChange={(e) => onChange(e.target.checked)}
          />
          允许局域网内其它设备访问
        </label>

        <div style={{ fontSize: 12.5, lineHeight: 2, color: 'var(--text-2)' }}>
          <div>
            当前监听：<code className="mono">{lan.listen || '—'}</code>
            {enabled ? <span className="badge orange" style={{ marginLeft: 8 }}>所有网卡</span>
              : <span className="badge gray" style={{ marginLeft: 8 }}>仅 127.0.0.1</span>}
          </div>
          {enabled && lanUrl && (
            <div>其它设备可用：<code className="mono">{lanUrl}</code></div>
          )}
          {enabled && !lanUrl && (
            <div style={{ color: 'var(--text-3)' }}>未检测到局域网 IP（可能没连 WiFi / 网线）。</div>
          )}
        </div>
      </div>

      {lan.overriddenBy && (
        <div className="plugin-manager-error" role="alert" style={{ marginBottom: 12 }}>
          该平台的环境变量 <b>{lan.overriddenBy}</b> 会覆盖 config.json，
          在这里改了也不生效。请先在平台的「配置」里去掉该环境变量。
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.9 }}>
        修改的是网关自己的 config.json（只改监听地址，端口不变），
        <b>需要重启该网关后生效</b>；修改前会自动备份一份配置。<br />
        {!enabled
          ? '当前仅本机可访问：只有这台机器上的程序能连。'
          : '开放后局域网内任何人都能调用该网关的接口——若该网关没有配置访问密钥，请谨慎开启。'}
      </div>
    </>
  )
}

function GroupsSection({ data }) {
  const groups = data.groups?.groups || {}
  const byName = {}
  for (const [uid, name] of Object.entries(groups)) {
    ;(byName[name] ||= []).push(uid)
  }
  const names = data.groups?.names || []
  // emptyNames 是「网关侧认为没有账号的分组名」，但顶层 groups（uid→分组）
  // 可能仍指向它（实测 groups 里还挂着 1 个账号，网关两侧状态不同步）。
  // 一个分组不能同时被说成「有 1 个账号」和「空分组」，
  // 以 groups 的实际情况为准，只把确实一个账号都没有的算空。
  const emptyOnly = (data.groups?.emptyNames || []).filter((nm) => !(byName[nm] || []).length)
  return (
    <>
      <div className="plugin-manager-section-title"><h3>账号分组</h3>
        <span className="sub">{names.length} 个分组名</span></div>
      {!names.length && <div className="plugin-manager-empty">该网关尚未配置任何分组。</div>}
      <div className="plugin-account-list">
        {names.map((name) => {
          const list = byName[name] || []
          return (
            <article className="plugin-account" key={name}>
              <div className="plugin-account-info"><b>{name}</b>
                <span className="sub">{list.length ? `${list.length} 个账号` : '暂无账号'}</span>
              </div>
              <span className={`badge ${list.length ? 'green' : 'gray'}`}>{list.length ? '使用中' : '空'}</span>
            </article>
          )
        })}
      </div>
      {!!emptyOnly.length && (
        <p className="sub" style={{ marginTop: 12 }}>
          空分组：{emptyOnly.join('、')}（没有账号，可在网关自带面板中删除）
        </p>
      )}
    </>
  )
}

function StatsSection({ data }) {
  const isWb = data.id === 'workbuddy'
  const accounts = data.accounts?.accounts || []
  const acc = data.accounts || {}
  // 各家统计来源不同，必须按真实字段取，否则界面会显示一排「—」：
  //   WorkBuddy → data.stats（吞吐/成功率）
  //   CodeArts  → data.accounts.stats
  //   Loomy     → data.accounts.totals
  //   Lingxi    → data.accounts（顶层计数）+ 账号积分合计
  const s = isWb ? (data.stats || {}) : { ...(acc.stats || acc.totals || {}), ...acc }
  // 总积分：只有明确给了才显示，否则按账号合计（都未知则显示 —）
  const creditSum = accounts.reduce((sum, a) => sum + (typeof a.credits === 'number' ? a.credits : 0), 0)
  const credits = typeof s.credits === 'number' ? s.credits
    : (accounts.some((a) => typeof a.credits === 'number') ? creditSum : null)

  return (
    <>
      <div className="plugin-manager-section-title"><h3>统计</h3>
        {isWb && s.lastTs && <span className="sub">数据截至 {s.lastTs}</span>}
        {!isWb && acc.balanceRefreshedAt && <span className="sub">余额刷新于 {String(acc.balanceRefreshedAt).replace('T', ' ').slice(0, 16)}</span>}
      </div>
      <div className="metrics" style={{ marginBottom: 16 }}>
        {isWb ? <>
          <Metric label="总请求" value={n(s.totalRequests)} />
          <Metric label="成功 / 失败" value={`${n(s.ok)} / ${n(s.errors)}`} />
          <Metric label="成功率" value={pct(s.successRate)} />
          <Metric label="总 Token" value={n(s.tokensTotal)} />
        </> : <>
          <Metric label="账号总数" value={n(s.total ?? accounts.length)} />
          <Metric label="健康 / 可用" value={n(s.healthy ?? s.usable)} />
          <Metric label="冷却中" value={n(s.cooling)} />
          <Metric label="总积分" value={n(credits)} />
        </>}
      </div>
      {isWb && !!Object.keys(s.statusCounts || {}).length && (
        <p className="sub">状态码分布：{Object.entries(s.statusCounts).map(([k, v]) => `${k}×${v}`).join(' · ')}</p>
      )}
      {isWb && !!s.byAccount?.length && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead><tr><th>账号</th><th>请求</th><th>失败</th><th>成功率</th><th>Token</th><th>平均首字</th></tr></thead>
            <tbody>
              {s.byAccount.slice(0, 20).map((a) => (
                <tr key={a.key}>
                  <td className="mono">{a.key}</td>
                  <td className="num">{n(a.requests)}</td>
                  <td className="num">{n(a.errors)}</td>
                  <td className="num">{pct(a.successRate)}</td>
                  <td className="num">{n(a.tokens)}</td>
                  <td className="num">{a.avgTtfbMs != null ? `${a.avgTtfbMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* 其余三家：逐账号表直接从账号视图派生，不再要求用户去别的分区找 */}
      {!isWb && !!accounts.length && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead><tr><th>账号</th><th>状态</th><th>积分</th><th>请求</th><th>失败</th><th>今日签到</th></tr></thead>
            <tbody>
              {accounts.slice(0, 40).map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.name}</td>
                  <td>{a.enabled ? <span className="badge green">启用</span> : <span className="badge gray">停用</span>}</td>
                  <td className="num">{n(a.credits != null ? a.credits : a.available)}</td>
                  <td className="num">{n(a.requests)}</td>
                  <td className="num">{n(a.failures ?? a.errCount)}</td>
                  <td>{todayCheckinText(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!isWb && !accounts.length && (
        <p className="sub">该网关当前没有账号，暂无逐账号统计。</p>
      )}
    </>
  )
}

/** 逐账号签到状态的短文案（表格用） */
function todayCheckinText(a) {
  if (a.enterprise) return '企业号无签到'
  return (a.checkinDone || a.lastCheckinDay === todayCN() || a.checkin?.day === todayCN())
    ? '已签到' : '未签到'
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  )
}

function ScheduleSection({ data, onRun, busy }) {
  const tasks = data.schedule?.tasks || []
  return (
    <>
      <div className="plugin-manager-section-title"><h3>定时任务</h3>
        <span className="sub">{tasks.filter((t) => t.enabled).length} 个已启用</span>
      </div>
      {!tasks.length && <div className="plugin-manager-empty">该网关没有可展示的排程任务。</div>}
      <div className="plugin-option-list">
        {tasks.map((t) => (
          <article className="plugin-option" key={t.key} style={{ cursor: 'default' }}>
            <span>
              <b>{t.label || t.key}</b>
              <span className="sub">{t.note || '整点运行'}</span>
              <span className="sub mono">
                时间 {t.hours?.length ? t.hours.map((h) => `${h}:00`).join(' / ') : '—'}
                {t.nextRun ? ` · 下次 ${String(t.nextRun).replace('T', ' ').slice(0, 16)}` : ''}
                {t.lastRun ? ` · 上次 ${String(t.lastRun).replace('T', ' ').slice(0, 16)}` : ''}
              </span>
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <span className={`badge ${t.enabled ? 'green' : 'gray'}`}>{t.enabled ? '已启用' : '已停用'}</span>
              {t.key === 'checkin' && (
                <button className="btn sm" disabled={!!busy} onClick={() => onRun(t.key)}>
                  {busy ? '执行中…' : '立即执行'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

function CreditsSection({ data, accounts, busy, isBusy, onExtras }) {
  const sorted = [...accounts].sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1))
  return (
    <>
      <div className="plugin-manager-section-title"><h3>积分</h3>
        <span className="sub">{accounts.length} 个账号</span>
      </div>
      {!accounts.length && <div className="plugin-manager-empty">没有账号可展示积分。</div>}
      <div className="plugin-quota-list">
        {sorted.map((a) => (
          <article className="plugin-quota" key={a.id}>
            <div className="plugin-quota-head">
              <b>{a.name}</b>
              <span className="sub">{a.credits != null ? `剩余 ${fmtNum(a.credits)}` : '积分未知'}
                {a.creditTotal != null ? ` / 总额 ${fmtNum(a.creditTotal)}` : ''}</span>
            </div>
            {a.credits != null && a.creditTotal > 0 && (
              <div className="progress">
                <div className="bar" style={{ width: `${Math.max(0, Math.min(100, (a.credits / a.creditTotal) * 100))}%` }} />
              </div>
            )}
            <div className="plugin-quota-foot">
              <span>{a.expiresAt ? `到期 ${String(a.expiresAt).slice(0, 10)}` : ''}</span>
              <button className="btn sm ghost" disabled={!!busy}
                onClick={() => onExtras(a, 'credits-refresh', '刷新额度')}>
                {isBusy('credits-refresh', a.id) ? '刷新中…' : '刷新额度'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

function PointsSection({ data }) {
  const p = data.points || {}
  return (
    <>
      <div className="plugin-manager-section-title"><h3>积分</h3>
        {p.account && <span className="sub">账号 {p.account}</span>}
      </div>
      {p.dailyQuota == null && p.permanentBalance == null && (
        <div className="plugin-manager-empty">该网关未返回积分概览，可能是尚未选中账号。</div>
      )}
      {(p.dailyQuota != null || p.permanentBalance != null) && (
        <div className="metrics" style={{ marginBottom: 16 }}>
          <Metric label="每日额度" value={n(p.dailyQuota)} />
          <Metric label="今日已用" value={n(p.dailyConsumed)} />
          <Metric label="每日余额" value={n(p.dailyBalance)} />
          <Metric label="永久余额" value={n(p.permanentBalance)} />
        </div>
      )}
      {!!p.dailyCycleDate && <p className="sub">周期日 {p.dailyCycleDate}</p>}
      {!!p.recent?.length && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead><tr><th>时间</th><th>模型</th><th>方向</th><th>积分</th><th>说明</th></tr></thead>
            <tbody>
              {p.recent.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.at ? String(r.at).replace('T', ' ').slice(0, 16) : '—'}</td>
                  <td>{r.model || '—'}</td>
                  <td>{r.direction === 'debit' ? '扣减' : r.direction === 'credit' ? '入账' : r.direction || '—'}</td>
                  <td className="num">{n(r.points)}</td>
                  <td className="sub">{r.description || r.source || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function UsageSection({ data }) {
  const t = data.usage?.totals || {}
  return (
    <>
      <div className="plugin-manager-section-title"><h3>用量</h3>
        {data.usage?.generated && <span className="sub">生成于 {String(data.usage.generated).replace('T', ' ').slice(0, 16)}</span>}
      </div>
      <div className="metrics" style={{ marginBottom: 16 }}>
        <Metric label="请求" value={n(t.requests)} />
        <Metric label="错误" value={n(t.errors)} />
        <Metric label="总 Token" value={n(t.totalTokens)} />
        <Metric label="平均延迟" value={t.avgLatencyMs != null ? `${t.avgLatencyMs} ms` : '—'} />
      </div>
      {!!data.usage?.byAccount?.length && (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>账号</th><th>请求</th><th>错误</th><th>Token</th></tr></thead>
            <tbody>
              {data.usage.byAccount.map((a, i) => (
                <tr key={a.key || i}>
                  <td className="mono">{a.key || '—'}</td>
                  <td className="num">{n(a.requests)}</td>
                  <td className="num">{n(a.errors)}</td>
                  <td className="num">{n(a.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function LogsSection({ lines, error, loading, onReload }) {
  return (
    <>
      <div className="plugin-manager-section-title">
        <h3>最近日志</h3>
        <button className="btn sm" disabled={loading} onClick={onReload}>{loading ? '读取中…' : '刷新日志'}</button>
      </div>
      {error && <div className="plugin-manager-error" role="alert">{error.message}</div>}
      {!error && !lines && loading && <Loading text="读取日志…" />}
      {!error && lines && !lines.length && <div className="plugin-manager-empty">日志为空。</div>}
      {!!lines?.length && (
        <div className="log-stream" style={{ height: 'calc(100vh - 300px)', minHeight: 240 }}>
          {lines.map((line, i) => (
            <div className="log-line" key={i}><span className="lt mono">{line}</span></div>
          ))}
        </div>
      )}
    </>
  )
}