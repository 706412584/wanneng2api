import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useBusy, useConfirm } from './Busy'
import { ErrorBox, Loading } from './Bits'
import { useToast } from './Toast'

const localText = (labels, fallback) => labels?.['zh-CN'] || labels?.zh || fallback || ''
const waiting = (flow) => flow?.id && ['waiting', 'installing', 'starting'].includes(flow.state)
const hasLoginDraft = (flow) => flow && ['prompt', 'key', 'choose'].includes(flow.state)

/** 北京时间的“今天”，与内核签到判定同一口径 */
const todayCN = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

/** 桌面壳存在时才有无痕窗口能力（浏览器管理台没有 IPC） */
const isDesktop = typeof window !== 'undefined' && !!window.wannengShell?.isDesktop

/** 重置时间显示成本地日期；解析不了就原样给出 */
function resetText(value) {
  if (!value) return ''
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return value
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 一个账号今天的签到状态：只有 day 是今天且不是 failed 才算已签到 */
function checkinState(account) {
  const today = todayCN()
  if (!account.day) return { done: false, text: '今日未签到' }
  // 只有「已领取/已完成」才算今天签过；ineligible / inactive / captcha /
  // own-app 都是**没签成**，按钮必须保持可用，并说明原因。
  // again = 上游说今天已签但内核还要再确认，同样不算完成。
  const completed = account.day === today
    && (account.outcome === 'claimed' || account.outcome === 'done')
    && !account.again
  if (completed) {
    const extra = [account.credit, account.streak ? `${account.streak} 天连签` : ''].filter(Boolean).join(' · ')
    return { done: true, text: extra ? `今日已签到 · ${extra}` : '今日已签到' }
  }
  if (account.day !== today) return { done: false, text: `今日未签到（上次 ${account.day}）` }
  const why = account.message || {
    ineligible: '账号不满足签到条件',
    inactive: '当前没有签到活动',
    captcha: '需要验证码，请在官方客户端签到',
    'own-app': '该服务只允许在官方客户端签到',
  }[account.outcome] || '签到未成功'
  return { done: false, text: `今日未签到：${why}` }
}

export default function PluginManager({ plugin, onClose, onChanged }) {
  const [provider, setProvider] = useState(plugin.providers?.[0] || '')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('accounts')
  const [modelDraft, setModelDraft] = useState(null)
  const [optionDraft, setOptionDraft] = useState({})
  const [query, setQuery] = useState('')
  const [flow, setFlow] = useState(null)
  const [answer, setAnswer] = useState('')
  const [working, setWorking] = useState(false)
  // 按账号记录签到中状态：整页 working 会让所有账号按钮一起显示“签到中…”
  const [checkinBusy, setCheckinBusy] = useState('')
  const generation = useRef(0)
  const dialogRef = useRef(null)
  const loginRef = useRef(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { run } = useBusy()
  const selected = modelDraft ?? data?.chosen ?? []
  const dirty = modelDraft !== null || Object.keys(optionDraft).length > 0

  const request = (action, body = {}) => api.magpiePluginAction(plugin.package, provider, action, body)
  const refresh = async () => {
    const current = ++generation.current
    try {
      const result = await api.magpiePluginPanel(plugin.package, provider)
      if (generation.current !== current) return
      setData(result)
      setError(null)
    } catch (e) {
      if (generation.current === current) setError(e)
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }

  useEffect(() => {
    generation.current += 1
    setData(null)
    setError(null)
    setLoading(true)
    setFlow(null)
    setAnswer('')
    setQuery('')
    refresh()
    return () => { generation.current += 1 }
  }, [provider, plugin.package])

  useEffect(() => {
    loginRef.current = waiting(flow) ? { provider, id: flow.id } : null
  }, [flow, provider])

  useEffect(() => () => {
    const login = loginRef.current
    if (login) api.magpiePluginAction(plugin.package, login.provider, 'signin-cancel', { id: login.id }).catch(() => {})
  }, [plugin.package])

  useEffect(() => {
    if (!waiting(flow)) return
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const next = await request('signin-status', { id: flow.id })
        if (cancelled) return
        setFlow((previous) => ({ ...previous, ...next }))
        if (next.state === 'done') {
          toast(`${data?.name || plugin.name} 登录成功`)
          refresh()
          onChanged?.()
          return
        }
        if (!waiting(next)) return
      } catch (e) {
        if (cancelled) return
        setError(e)
      }
      timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [flow?.id, flow?.state, provider])

  useEffect(() => {
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    // 焦点锁挂 document：点抽屉内非可聚焦文字后 activeElement 会变成 body，
    // 只挂 section 的 onKeyDown 就拦不住 Tab，焦点能跑到背后的侧栏去。
    const onKey = (e) => handleKeyDown(e)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      previous?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const leave = async (nextProvider) => {
    if (working) return
    if ((dirty || waiting(flow) || hasLoginDraft(flow)) && !await confirm('未保存的修改将被放弃，进行中的登录也会取消。是否继续？', { title: '离开插件管理' })) return
    if (waiting(flow)) {
      try { await request('signin-cancel', { id: flow.id }); loginRef.current = null }
      catch (e) { toast(e.message, 'err'); return }
    }
    setModelDraft(null)
    setOptionDraft({})
    if (nextProvider) setProvider(nextProvider)
    else { onChanged?.(); onClose() }
  }

  /** 抽屉内可聚焦元素（排除被隐藏的） */
  const focusables = () => [...(dialogRef.current?.querySelectorAll(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
  ) || [])].filter((node) => node.getClientRects().length)

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); leave(); return }
    if (e.key !== 'Tab') return
    const list = focusables()
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    // 焦点已经掉到抽屉外（点到非可聚焦区域）时，先拉回来再按方向走
    const active = document.activeElement
    if (!dialogRef.current?.contains(active)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first)?.focus()
      return
    }
    if (e.shiftKey && (active === first || active === dialogRef.current)) { e.preventDefault(); last?.focus() }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first?.focus() }
  }

  const act = async (label, action, body = {}) => {
    if (working) return
    setWorking(true)
    try {
      // 记下这一代：期间若切换了 provider，旧结果必须丢弃而不是覆盖新数据
      const current = ++generation.current
      const result = await run(label, () => request(action, body))
      if (generation.current !== current) return null
      setData(result)
      setError(null)
      onChanged?.()
      return result
    } catch (e) {
      setError(e)
      toast(e.message, 'err')
      return null
    } finally { setWorking(false) }
  }

  const accountAction = async (account, action) => {
    if (action === 'account-remove' && !await confirm(`从 ${data.name} 移除账号 ${account.user}？再次使用时需要重新登录。`, { title: '移除插件账号', danger: true, okText: '移除' })) return
    await act('正在更新插件账号…', action, { user: account.user })
  }

  const signIn = async (method, user, inputs = {}, response) => {
    if (working) return
    setWorking(true)
    setError(null)
    setAnswer('')
    try {
      const prompt = await request('signin-prompt', { method, inputs, ...response })
      const next = { method, user, inputs: prompt.inputs || inputs }
      if (prompt.prompt) { setFlow({ ...next, state: 'prompt', prompt: prompt.prompt }); return }
      const descriptor = data.methods.find((m) => m.index === method)
      if (descriptor?.type === 'api' && !descriptor.keyless && !descriptor.keyAsked) {
        setFlow({ ...next, state: 'key', placeholder: descriptor.placeholder })
        return
      }
      const result = await request('signin-start', { ...next, ...(descriptor?.type === 'api' ? { key: '' } : {}) })
      setFlow({ ...next, ...result })
      if (result.state === 'done') { refresh(); onChanged?.(); toast('登录成功') }
    } catch (e) { setError(e); setFlow((previous) => ({ ...previous, state: 'failed', message: e.message })) }
    finally { setWorking(false) }
  }

  const submitAnswer = async (e) => {
    e.preventDefault()
    if (flow.state === 'prompt') return signIn(flow.method, flow.user, flow.inputs, { key: flow.prompt.key, value: answer })
    setWorking(true)
    try {
      const result = await request('signin-start', { method: flow.method, inputs: flow.inputs, user: flow.user, key: answer })
      setAnswer('')
      setFlow({ ...flow, ...result })
      if (result.state === 'done') { refresh(); onChanged?.(); toast('登录成功') }
    } catch (e) { setError(e) }
    finally { setWorking(false) }
  }

  const cancelLogin = async () => {
    if (waiting(flow)) {
      setWorking(true)
      try { await request('signin-cancel', { id: flow.id }); loginRef.current = null }
      catch (e) { setError(e); return }
      finally { setWorking(false) }
    }
    setFlow(null)
    setAnswer('')
  }

  /**
   * 打开授权页。桌面壳走 IPC（可开无痕窗口），纯浏览器管理台没有该能力，
   * 一律退化为新标签页打开——不假装支持无痕。
   */
  const openAuthorization = async (url, mode) => {
    try {
      if (isDesktop) {
        const r = await window.wannengShell.openLogin(url, mode)
        if (!r?.ok) throw new Error(r?.error || '打开授权页失败')
        toast(mode === 'incognito' ? '已打开无痕登录窗口' : '已在系统浏览器打开授权页')
        return
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) { toast(e.message, 'err') }
  }

  const toggleProvider = async (on) => {
    const result = await act(on ? '正在启用该平台…' : '正在禁用该平台…', 'provider-toggle', { on })
    if (result) toast(on ? '已启用，平台重新参与路由' : '已禁用，平台不再参与路由（配置保留）')
  }

  const doCheckin = async (account) => {
    if (working || checkinBusy) return
    setCheckinBusy(account.key)
    try {
      const current = ++generation.current
      const result = await request('checkin', { key: account.key })
      if (generation.current !== current) return
      setData(result)
      setError(null)
      const now = result.checkin.accounts.find((a) => a.key === account.key)
      const state = now ? checkinState(now) : null
      toast(state?.done ? `${account.user || account.key} 签到成功` : `签到未成功${state?.text ? `：${state.text}` : ''}`,
        state?.done ? 'ok' : 'err')
      onChanged?.()
    } catch (e) { setError(e); toast(e.message, 'err') }
    finally { setCheckinBusy('') }
  }

  // 一键签到：逐个账号依次签（内核只有按账号的端点）。结果按后端回报的
  // 成功/失败数如实提示——部分账号签不了（如 Qoder 需要官方客户端身份）
  // 不能一句「已完成」盖过去。
  const checkinAll = async () => {
    if (working || checkinBusy) return
    setCheckinBusy('*')
    try {
      const current = ++generation.current
      const result = await request('checkin-all')
      if (generation.current !== current) return
      setData(result)
      setError(null)
      const info = result.checkinAll
      if (info?.failed) {
        toast(`已签到 ${info.succeeded}/${info.count}，${info.failed} 个失败${info.failures?.[0]?.message ? `：${info.failures[0].message}` : ''}`, 'err')
      } else {
        toast(info?.count ? `已签到全部 ${info.count} 个账号` : '没有可签到的账号', info?.count ? 'ok' : 'err')
      }
      onChanged?.()
    } catch (e) { setError(e); toast(e.message, 'err') }
    finally { setCheckinBusy('') }
  }

  const saveModels = async () => {
    const result = await act('正在保存模型选择…', 'models-save', { models: selected })
    if (result) { setModelDraft(null); toast('模型选择已保存') }
  }

  const saveOptions = async () => {
    if (working) return
    setWorking(true)
    const current = ++generation.current
    try {
      for (const [key, on] of Object.entries(optionDraft)) {
        const result = await request('option-save', { key, on })
        // 期间切换了 provider：结果属于旧 provider，丢弃
        if (generation.current !== current) return
        setData(result)
        setOptionDraft((previous) => { const rest = { ...previous }; delete rest[key]; return rest })
      }
      setError(null)
      toast('插件选项已保存')
      onChanged?.()
    } catch (e) { setError(e); toast(e.message, 'err') }
    finally { setWorking(false) }
  }

  const advanced = async () => {
    try { await api.openPanel('magpie-web', { view: 'providers', edit: provider }) }
    catch (e) { toast(e.message, 'err') }
  }

  return (
    <div className="plugin-manager-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) leave() }}>
      <section className="plugin-manager" role="dialog" aria-modal="true" aria-labelledby="plugin-manager-title" tabIndex={-1} ref={dialogRef} onKeyDown={(e) => e.stopPropagation()}>
        <header className="plugin-manager-head">
          <div>
            <span className="plugin-manager-eyebrow">插件管理 · {data?.version ? `v${data.version}` : 'magpie'}</span>
            <h2 id="plugin-manager-title">{plugin.name}</h2>
            <div className="plugin-manager-package mono">{plugin.package}</div>
          </div>
          <button className="btn ghost" onClick={() => leave()} disabled={working} aria-label="关闭插件管理">关闭</button>
        </header>
        <div className="plugin-manager-toolbar">
          <label className="field" htmlFor="plugin-provider">接入服务
            <select className="select" id="plugin-provider" value={provider} disabled={working} onChange={(e) => leave(e.target.value)}>
              {(data?.providers || plugin.providers?.map((id) => ({ id, name: id })) || []).map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
          </label>
          <span className={`badge ${data?.signedIn ? 'green' : 'gray'}`}>{data?.signedIn ? '已登录' : '未登录'}</span>
          {data && <label className={`plugin-toggle ${data.off ? 'off' : ''}`} title={data.off ? '已禁用：该平台不参与路由，配置保留' : '已启用：该平台参与路由'}>
            <input type="checkbox" role="switch" checked={!data.off} disabled={working}
              onChange={(e) => toggleProvider(e.target.checked)} />
            <span>参与路由</span>
          </label>}
          <button className="btn sm" disabled={working || loading} onClick={refresh}>刷新状态</button>
        </div>
        <nav className="plugin-manager-tabs" role="tablist" aria-label="插件管理分类">
          {[
            ['accounts', '账号'],
            ['models', '模型'],
            // 只有内核真的报了额度窗口才出现，避免空页
            ...(data?.quota?.available || data?.quota?.error ? [['quota', '额度']] : []),
            // 只有内核报告支持签到时才出现，避免无签到能力的插件露出空页
            ...(data?.checkin?.supported ? [['checkin', '签到']] : []),
            ['options', '插件选项'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              id={'pmtab-' + id}
              aria-selected={tab === id}
              aria-controls="pm-panel"
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >{label}</button>
          ))}
        </nav>
        <div className="plugin-manager-body" id="pm-panel" role="tabpanel" aria-labelledby={'pmtab-' + tab}>
          {loading && !data ? <Loading text="读取插件状态…" /> : error && !data ? <ErrorBox error={error} onRetry={refresh} /> : data && <>
            {error && <div className="plugin-manager-error" role="alert">{error.message}</div>}
            {tab === 'accounts' && <>
              <div className="plugin-manager-section-title"><h3>已登录账号</h3><span className="sub">{data.accounts.length} 个账号</span></div>
              {!data.accounts.length && <div className="plugin-manager-empty">尚未登录此服务。请选择下方登录方式添加账号。</div>}
              <div className="plugin-account-list">
                {data.accounts.map((account) => <article className="plugin-account" key={account.user}>
                  <div className="plugin-account-info"><b>{account.user}</b><span className="sub">{account.plan || '插件账号'}</span></div>
                  <span className={`badge ${account.on && !account.paused ? 'green' : 'gray'}`}>{account.on && !account.paused ? '使用中' : '已暂停'}</span>
                  <div className="plugin-account-actions">
                    <button className="btn sm" disabled={working} onClick={() => accountAction(account, account.on && !account.paused ? 'account-off' : 'account-on')}>{account.on && !account.paused ? '暂停' : '启用'}</button>
                    <button className="btn sm ghost" disabled={working || waiting(flow)} onClick={() => setFlow({ state: 'choose', user: account.user })}>重新登录</button>
                    <button className="btn sm ghost" disabled={working} onClick={() => accountAction(account, 'account-remove')}>移除</button>
                  </div>
                </article>)}
              </div>
              <div className="plugin-login-section">
                <h3>{flow?.user ? '重新登录账号' : '添加账号'}</h3>
                {!flow || flow.state === 'choose' || ['failed', 'canceled', 'done'].includes(flow.state) ? <>
                  {flow?.message && <p className="sub">{flow.message}</p>}
                  <div className="plugin-login-methods">
                    {data.methods.map((method) => <button className="btn" key={method.index} disabled={working} onClick={() => signIn(method.index, flow?.user)}>{localText(method.labels, method.label)}</button>)}
                  </div>
                  {!data.methods.length && <div className="plugin-manager-empty">此插件没有提供登录方式，可使用「高级控制台」查看内核支持情况。</div>}
                </> : <div className="plugin-login-flow" aria-live="polite">
                  {['prompt', 'key'].includes(flow.state) ? <form onSubmit={submitAnswer} className="field">
                    <label htmlFor="plugin-login-answer">{flow.state === 'key' ? 'API Key' : localText(flow.prompt.messages, flow.prompt.label || flow.prompt.message || flow.prompt.key)}</label>
                    {flow.prompt?.options?.length ? <select className="select" id="plugin-login-answer" value={answer} disabled={working} onChange={(e) => setAnswer(e.target.value)} required>
                      <option value="">请选择…</option>{flow.prompt.options.map((o) => <option key={o.value} value={o.value}>{localText(o.labels, o.label || o.value)}</option>)}
                    </select> : <input className="input" id="plugin-login-answer" type={flow.state === 'key' || flow.prompt?.secret ? 'password' : 'text'} value={answer} disabled={working} autoComplete="off" placeholder={flow.placeholder || flow.prompt?.placeholder || ''} onChange={(e) => setAnswer(e.target.value)} required />}
                    <p className="sub">内容仅发送给本机内核，不会存储在浏览器中。</p>
                    <button className="btn primary" disabled={working} type="submit">{working ? '提交中…' : '继续'}</button>
                  </form> : <>
                    <b>{flow.state === 'installing' ? '正在准备登录组件…' : '等待完成授权'}</b>
                    {flow.url && <div className="plugin-login-open">
                      <button className="btn primary" disabled={working} onClick={() => openAuthorization(flow.url, 'system')}>系统浏览器打开</button>
                      {isDesktop && <button className="btn" disabled={working} onClick={() => openAuthorization(flow.url, 'incognito')}>无痕窗口打开</button>}
                    </div>}
                    {flow.code && <div className="plugin-device-code">设备码 <code>{flow.code}</code></div>}
                    <p className="sub">完成授权后此面板会自动更新，不会跳转到核心控制台。</p>
                  </>}
                  <button className="btn sm ghost" disabled={working} onClick={cancelLogin}>取消登录</button>
                </div>}
              </div>
            </>}
            {tab === 'models' && <>
              <div className="plugin-manager-section-title"><h3>提供的模型</h3><span className="sub">已选 {selected.length} / {data.models.length}</span></div>
              <div className="plugin-model-toolbar">
                <input className="input" aria-label="搜索插件模型" placeholder="搜索模型名称或 ID…" value={query} onChange={(e) => setQuery(e.target.value)} />
                <button className="btn sm" disabled={working || !data.models.length} onClick={() => setModelDraft(data.models.map((m) => m.id))}>全选</button>
                <button className="btn sm" disabled={working || !data.models.length} onClick={() => setModelDraft([])}>全不选</button>
                <button className="btn sm" disabled={working || !data.signedIn} onClick={() => act('正在重新获取插件模型…', 'models-refresh')}>重新获取模型</button>
              </div>
              {!data.models.length && <div className="plugin-manager-empty">{data.signedIn ? '此服务暂无模型，可尝试重新获取。' : '登录后可获取此服务提供的模型。'}</div>}
              <div className="plugin-model-list">
                {data.models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase())).map((model) => <label className={`plugin-model ${selected.includes(model.id) ? 'selected' : ''}`} key={model.id}>
                  <input type="checkbox" checked={selected.includes(model.id)} disabled={working} onChange={(e) => setModelDraft(e.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id))} />
                  <span><b>{model.name || model.id}</b><span className="mono sub">{model.id}</span></span>
                  {model.context > 0 && <span className="sub">{Math.round(model.context / 1024)}K</span>}
                </label>)}
              </div>
              <div className="plugin-manager-save"><span className="sub">只修改模型选择，不改变路由、代理和密钥。</span><button className="btn primary" disabled={working || modelDraft === null} onClick={saveModels}>保存模型选择</button></div>
            </>}
            {tab === 'quota' && <>
              <div className="plugin-manager-section-title">
                <h3>额度</h3>
                <span className="sub">{data.quota.plan ? `套餐 ${data.quota.plan}` : ""}</span>
              </div>
              {data.quota.error && <div className="plugin-manager-error" role="alert">上游未给出额度：{data.quota.error}</div>}
              {!data.quota.windows.length && !data.quota.error && <div className="plugin-manager-empty">该服务的上游没有返回额度信息。</div>}
              <div className="plugin-quota-list">
                {data.quota.windows.map((w) => <article className="plugin-quota" key={w.name}>
                  <div className="plugin-quota-head">
                    <b>{w.name}</b>
                    {/* 计数用 amount/limit：used 是百分比，拿它当计数会显示错 */}<span className="mono sub">{w.amount !== null && w.limit > 0
                      ? `${w.amount} / ${w.limit}${w.unit ? ' ' + w.unit : ''}`
                      : (w.display || '上游未给上限')}</span>
                  </div>
                  {w.percent !== null
                    ? <div className="progress"><div className="bar" style={{ width: `${w.percent}%` }} /></div>
                    : <div className="plugin-quota-nolimit">上游只给了用量描述，没有百分比，不画进度条</div>}
                  <div className="plugin-quota-foot">
                    {w.percent !== null && <span>{w.percent}% 已用</span>}
                    {w.resetsAt && <span>重置 {resetText(w.resetsAt)}</span>}
                  </div>
                </article>)}
              </div>
              <p className="sub" style={{ marginTop: 14 }}>额度由内核向各服务实时读取；没有上限的窗口不会画进度条，避免显示错误的比例。</p>
            </>}
            {tab === 'checkin' && <>
              <div className="plugin-manager-section-title"><h3>每日签到</h3><span className="sub">{data.checkin.accounts.length} 个账号</span></div>
              {!data.checkin.accounts.length && <div className="plugin-manager-empty">该插件还没有登录账号，登录后才能签到。</div>}
              <div className="plugin-checkin-list">
                {data.checkin.accounts.map((account) => {
                  const state = checkinState(account)
                  return <article className="plugin-checkin" key={account.key}>
                    <div className="plugin-checkin-info">
                      <b>{account.user || account.key}</b>
                      <span className={state.done ? 'badge green' : 'badge gray'}>{state.text}</span>
                    </div>
                    <button className="btn sm primary" disabled={!!checkinBusy || state.done || working} onClick={() => doCheckin(account)}>
                      {checkinBusy === account.key ? '签到中…' : state.done ? '已签到' : '立即签到'}
                    </button>
                  </article>
                })}
              </div>
              {!!data.checkin.accounts.length && (
                <div className="plugin-manager-save">
                  <span className="sub">一键签到会依次签该服务的全部账号；个别账号可能因上游限制签不了，结果会如实说明。</span>
                  <button className="btn primary" disabled={!!checkinBusy || working} onClick={checkinAll}>
                    {checkinBusy === '*' ? '签到中…' : '一键签到'}
                  </button>
                </div>
              )}
              <p className="sub" style={{ marginTop: 14 }}>签到由内核插件执行，等同于在该服务的官方客户端签到。每日自动签到开关在内核的用量设置里。</p>
            </>}
            {tab === 'options' && <>
              <div className="plugin-manager-section-title"><h3>插件选项</h3><span className="sub">由插件定义</span></div>
              {!data.options.length && <div className="plugin-manager-empty">此服务没有提供可配置的插件选项。</div>}
              <div className="plugin-option-list">{data.options.map((option) => <label className="plugin-option" key={option.key}>
                <span><b>{localText(option.labels, option.label || option.key)}</b><span className="sub">{localText(option.descriptions, option.description)}</span></span>
                <input type="checkbox" role="switch" checked={optionDraft[option.key] ?? option.on} disabled={working} onChange={(e) => setOptionDraft((previous) => ({ ...previous, [option.key]: e.target.checked }))} />
              </label>)}</div>
              {!!data.options.length && <div className="plugin-manager-save"><span className="sub">保存后由内核应用到该插件。</span><button className="btn primary" disabled={working || !Object.keys(optionDraft).length} onClick={saveOptions}>保存插件选项</button></div>}
            </>}
          </>}
        </div>
        <footer className="plugin-manager-foot"><span>{dirty ? '有未保存的修改' : '仅管理当前插件，不影响其它网关'}</span><button className="btn sm ghost" onClick={advanced}>高级控制台</button></footer>
      </section>
    </div>
  )
}
