import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useBusy, useConfirm } from './Busy'
import { useToast } from './Toast'
import Modal from './Modal'
import { fmtDateTime } from '../utils/format'

const SOURCE = {
  'self-hosted': ['自建', 'blue'],
  community: ['社区', 'purple'],
  local: ['本地', 'gray'],
}
const PHASE = { idle: '已同步', syncing: '同步中', partial: '部分完成', error: '同步失败' }

export default function MagpieAliasSyncCard() {
  const [open, setOpen] = useState(false)
  const [showProviders, setShowProviders] = useState(false)
  const [selected, setSelected] = useState('')
  const [action, setAction] = useState('')
  const toast = useToast()
  const confirm = useConfirm()
  const busy = useBusy()
  const fetchStatus = useCallback(() => api.magpieAliasSync(), [])
  const [intervalMs, setIntervalMs] = useState(5000)
  const polling = usePolling(fetchStatus, open ? intervalMs : 0, open)
  const { data, error, refresh } = polling
  const running = data?.status?.phase === 'syncing' || data?.status?.pending
  useEffect(() => { setIntervalMs(running ? 1000 : 5000) }, [running])
  useEffect(() => { setSelected(data?.selectedKeyId || '') }, [data?.selectedKeyId])

  const run = async (key, text, fn, success) => {
    if (action) return
    setAction(key)
    try {
      await busy.run(text, fn)
      if (success) toast(success)
      refresh()
    } catch (e) {
      toast(e.message, 'err')
    } finally { setAction('') }
  }

  const chooseKey = async () => {
    if (!selected || selected === data?.selectedKeyId) return
    const target = data?.keys?.find((k) => k.id === selected)
    if (!target?.eligible) return
    const accepted = await confirm(`将「${target.name}」设为 aliases 同步目标 Key 吗？\n\n只改变同步目标，不改变隧道当前接受哪些 caller keys。`, {
      title: '设置 aliases 同步目标', okText: '设置目标 Key',
    })
    if (!accepted) return
    await run('key', '正在设置同步目标 Key…', () => api.magpieAliasAction('select-key', { keyId: selected }), '目标 Key 已设置')
  }

  const setProvider = async (provider, authorized) => {
    const accepted = await confirm(authorized
      ? `允许目标 Key 使用「${provider.name}」当前及以后启用的模型吗？\n\n首次授权会把该 provider 的通配权限收敛为明确启用模型，自动维护裸名 aliases。插件凭证仍由 magpie 管理。`
      : `撤销「${provider.name}」的公网同步授权吗？\n\n只移除本功能托管的 Models/Aliases；不删除 provider、账号、模型或 Gateway Key。若这是最后一个托管授权且没有手工权限，目标 Key 会被禁用。`, {
      title: authorized ? '授权 provider 模型' : '撤销 provider 授权', okText: authorized ? '授权并同步' : '撤销授权', danger: !authorized,
    })
    if (!accepted) return
    await run(`provider:${provider.id}`, authorized ? `正在授权 ${provider.name}…` : `正在撤销 ${provider.name}…`,
      () => api.magpieAliasAction('provider-set', { providerId: provider.id, authorized }),
      authorized ? '授权已下发，正在同步模型' : '撤销已下发，正在收敛权限')
  }

  const aliases = data?.usage?.aliases || { used: 0, limit: 200 }
  const models = data?.usage?.models || { used: 0, limit: 500 }
  const conflicts = data?.conflicts || []
  const phase = running ? '同步中' : (PHASE[data?.status?.phase] || '待同步')
  const summary = data
    ? `${data.selectedKeyName || '未选择目标 Key'} · ${data.authorizedCount || 0} 个 provider · ${aliases.used}/${aliases.limit} aliases · ${conflicts.length} 个待处理`
    : '选择目标 Key，逐 provider 授权并自动维护裸模型名'

  return (
    <section className="card alias-sync-card">
      <button className="collapse-head" aria-expanded={open} aria-controls="alias-sync-body" onClick={() => setOpen((v) => !v)}>
        <span className={`caret ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
        <b>Magpie 公网模型别名</b>
        <span className={`badge ${running ? 'orange' : data?.status?.phase === 'error' ? 'red' : 'green'}`}>{phase}</span>
        <span className="sub">{summary}</span>
        <span style={{ flex: 1 }} />
        <span className="sub">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="alias-sync-body" id="alias-sync-body">
        <div className="alert-bar muted">
          <span>插件登录凭证用于 magpie 调用上游；Gateway Key 的 Models/Aliases 用于公网调用权限。这里只设置同步目标，不改变隧道鉴权范围。</span>
        </div>
        {(error || data?.stateError || data?.lastError) && <div className="plugin-manager-error" role="alert">
          {error?.message || data?.stateError || data?.lastError}
        </div>}
        <div className="alias-sync-key-row">
          <label className="field" htmlFor="alias-key">同步目标 Gateway Key
            <select className="input" id="alias-key" value={selected} disabled={!!action || running} onChange={(e) => setSelected(e.target.value)}>
              <option value="">请选择（不会自动使用第一把）</option>
              {(data?.keys || []).map((key) => <option key={key.id} value={key.id} disabled={!key.eligible}>
                {key.name}{key.eligible ? '' : `（${key.reason}）`}
              </option>)}
            </select>
          </label>
          <button className="btn" disabled={!!action || running || !selected || selected === data?.selectedKeyId} onClick={chooseKey}>设置目标 Key</button>
        </div>
        {!(data?.keys || []).length && <div className="sub">没有可用 Key，请先在 magpie 控制台的 Gateway keys 中创建。</div>}
        <div className="alias-sync-actions">
          <button className="btn primary" disabled={!!action || !data?.selectedKeyId} onClick={() => setShowProviders(true)}>管理 provider 授权</button>
          <button className="btn" disabled={!!action || running || !data?.selectedKeyId}
            onClick={() => run('sync', '正在下发模型与 aliases 同步…', () => api.magpieAliasAction('sync'), '同步已下发')}>立即同步</button>
          <button className="btn ghost" disabled={!!action} onClick={refresh}>刷新状态</button>
        </div>
        <div className="alias-sync-usage">
          <span>Aliases <b>{aliases.used}</b> / {aliases.limit}（托管 {aliases.managed || 0}）</span>
          <span>Models <b>{models.used}</b> / {models.limit}（托管 {models.managed || 0}）</span>
          <span>最近成功 {fmtDateTime(data?.lastSuccessAt)}</span>
        </div>
        {!!conflicts.length && <div className="alias-sync-conflicts">
          <b>待处理冲突（不会静默选择第一家）</b>
          {conflicts.slice(0, 6).map((item, index) => <div className="alias-sync-conflict" key={`${item.code}-${item.model || index}`}>
            <span>{item.message}</span>
            {(item.providerIds || item.groupId) && <span className="sub mono">{[item.groupId, ...(item.providerIds || [])].filter(Boolean).join(' · ')}</span>}
          </div>)}
          <div className="sub">同名模型请在 Hub「模型优先级」准备仅含已授权成员的静态路由组。</div>
        </div>}
      </div>}

      {showProviders && <Modal title="provider 公网授权" onClose={() => setShowProviders(false)} wide>
        <div className="alert-bar muted">
          <span>逐 provider 首次明确授权，之后自动跟随启用模型。社区和本地插件凭证仍由 magpie 管理，壳不会读取或复制。</span>
        </div>
        <div className="plugin-account-list">
          {(data?.providers || []).map((provider) => {
            const [label, color] = SOURCE[provider.source] || SOURCE.local
            return <article className="plugin-account" key={provider.id}>
              <div className="plugin-account-info">
                <b>{provider.name} <span className={`badge ${color}`}>{label}</span></b>
                <span className="sub mono">{provider.id}</span>
                <span className="sub">
                  {provider.off ? 'provider 已禁用' : provider.ready ? '已就绪' : '未就绪'}
                  {' · '}{provider.modelCountKnown ? `${provider.modelCount} 个启用模型` : '模型目录未知'}
                  {provider.credential === 'config' ? ' · 普通 Key 自动读取本机 config' : ' · 凭证由 magpie 管理'}
                </span>
                {provider.error && <span className="alias-provider-error">最近刷新失败：{provider.error}</span>}
              </div>
              <label className={`plugin-toggle ${provider.authorized ? '' : 'off'}`}>
                <input type="checkbox" checked={!!provider.authorized} disabled={!!action || !data?.selectedKeyId}
                  onChange={(e) => setProvider(provider, e.target.checked)} />
                {provider.authorized ? '已授权' : '未授权'}
              </label>
            </article>
          })}
        </div>
        {!(data?.providers || []).length && <div className="plugin-manager-empty">暂未读取到 magpie provider。</div>}
      </Modal>}
    </section>
  )
}
