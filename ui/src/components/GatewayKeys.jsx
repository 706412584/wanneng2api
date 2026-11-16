import { useCallback, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useBusy, useConfirm } from './Busy'
import { useToast } from './Toast'
import Modal from './Modal'
import { Empty, ErrorBox, Loading } from './Bits'
import { fmtNum, fmtTokens } from '../utils/format'

const PERIODS = [
  ['day', '每日'],
  ['week', '每周'],
  ['month', '每月'],
  ['days', '每 N 天'],
  ['hours', '每 N 小时'],
  ['total', '累计（不按周期重置）'],
]

const PERIOD_SHORT = { day: '每日', week: '每周', month: '每月', total: '累计' }

function describe(limit) {
  if (!limit) return '无额度'
  const period = limit.period === 'days'
    ? `每 ${limit.days} 天`
    : limit.period === 'hours'
      ? `每 ${limit.hours} 小时`
      : PERIOD_SHORT[limit.period] || limit.period
  const caps = []
  if (limit.tokens) caps.push(`${fmtTokens(limit.tokens)} tokens`)
  if (limit.cost) caps.push(`$${limit.cost}`)
  const scope = Array.isArray(limit.models) && limit.models.length ? ` · ${limit.models.join(', ')}` : ''
  return `${period} · ${caps.join(' / ') || '无上限'}${limit.cacheReads ? ' · 含缓存读' : ''}${scope}`
}

function percent(used, limit) {
  if (!limit || limit <= 0 || used == null) return null
  return Math.min(100, Math.round((used / limit) * 100))
}

function UsageBar({ used, limit, label }) {
  const pct = percent(used, limit)
  if (pct == null) return null
  return <div className="gwkey-usage">
    <div className="progress"><div className={`bar ${pct >= 100 ? 'updating' : ''}`} style={{ width: `${pct}%` }} /></div>
    <span className="sub">{label} {fmtNum(used)} / {fmtNum(limit)}（{pct}%）</span>
  </div>
}

function toDraft(key) {
  const limit = key.limit || null
  const period = limit?.period || 'day'
  return {
    period,
    days: limit?.days || 7,
    hours: limit?.hours || 24,
    tokens: limit?.tokens || '',
    cost: limit?.cost || '',
    cacheReads: !!limit?.cacheReads,
    models: Array.isArray(limit?.models) ? limit.models.join(', ') : '',
  }
}

export default function GatewayKeys() {
  const fetchKeys = useCallback(() => api.magpieGatewayKeys(), [])
  const { data, error, loading, refresh } = usePolling(fetchKeys, 15000)
  const toast = useToast()
  const confirm = useConfirm()
  const busy = useBusy()
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(null)

  const keys = data?.keys || []

  const openEdit = (key) => {
    setEditing(key)
    setDraft(toDraft(key))
  }

  const save = async () => {
    if (!editing || !draft) return
    const models = draft.models.split(/[,，\s]+/).map((m) => m.trim()).filter(Boolean)
    await busy.run('正在保存额度…', async () => {
      try {
        await api.magpieSetGatewayKeyLimit(editing.id, {
          period: draft.period,
          days: draft.period === 'days' ? Number(draft.days) : undefined,
          hours: draft.period === 'hours' ? Number(draft.hours) : undefined,
          tokens: draft.tokens === '' ? 0 : Number(draft.tokens),
          cost: draft.cost === '' ? 0 : Number(draft.cost),
          cacheReads: draft.cacheReads,
          models,
        })
        toast('额度已保存')
        setEditing(null)
        refresh()
      } catch (e) {
        toast(e.message, 'err')
        throw e
      }
    })
  }

  const reset = async (key) => {
    const ok = await confirm(`把「${key.name}」本周期已用量清零吗？\n\nToken 与费用一起从当前时刻重新开始计数；不会修改额度上限。`, {
      title: '重置额度用量', okText: '重置用量',
    })
    if (!ok) return
    await busy.run('正在重置用量…', async () => {
      try {
        await api.magpieResetGatewayKeyLimit(key.id)
        toast('已重置本周期用量')
        refresh()
      } catch (e) {
        toast(e.message, 'err')
        throw e
      }
    })
  }

  if (loading && !data) return <Loading text="读取 Gateway Key 额度…" />
  if (error && !data) return <ErrorBox error={error} onRetry={refresh} />

  return (
    <>
      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span>网关密钥额度 <span className="sub">支持每 N 天 / 每 N 小时，原生页面只有日/周/月</span></span>
          <button className="btn sm" onClick={refresh}>刷新</button>
        </div>
        {!keys.length && <Empty icon="⚿" text="还没有 Gateway Key。请先在 magpie 控制台创建。" />}
        <div className="gwkey-list">
          {keys.map((key) => {
            const current = key.limit
            const used = key.used || {}
            return <div className="gwkey-row" key={key.id}>
              <div className="gwkey-info">
                <b>{key.name}</b>
                <span className="sub mono">{key.id}</span>
                <span className="sub">{describe(current)}</span>
                {current?.tokens > 0 && <UsageBar used={used.tokens} limit={used.tokenLimit || current.tokens} label="Token" />}
                {current?.cost > 0 && <UsageBar used={used.cost} limit={current.cost} label="费用" />}
                {used.reset && <span className="sub">下次重置 {used.reset.replace('T', ' ').slice(0, 16)}</span>}
                {key.more?.length > 0 && <span className="sub">另有 {key.more.length} 条附加额度</span>}
              </div>
              <div className="gwkey-actions">
                {key.off && <span className="badge gray">已禁用</span>}
                {key.readOnly && <span className="badge gray">只读</span>}
                <button className="btn sm" disabled={!!busy.value} onClick={() => openEdit(key)}>设置额度</button>
                <button className="btn sm ghost" disabled={!!busy.value || !current} onClick={() => reset(key)}>重置用量</button>
              </div>
            </div>
          })}
        </div>
      </div>

      {editing && draft && <Modal title={`额度 · ${editing.name}`} onClose={() => setEditing(null)} footer={
        <>
          <button className="btn" onClick={() => setEditing(null)}>取消</button>
          <button className="btn primary" disabled={!!busy.value} onClick={save}>保存额度</button>
        </>
      }>
        <label className="field" htmlFor="gwkey-period">计费周期
          <select className="input" id="gwkey-period" value={draft.period}
            onChange={(e) => setDraft({ ...draft, period: e.target.value })}>
            {PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {draft.period === 'days' && <label className="field" htmlFor="gwkey-days">每多少天
          <input className="input" id="gwkey-days" type="number" min="1" max="3650" value={draft.days}
            onChange={(e) => setDraft({ ...draft, days: e.target.value })} />
        </label>}
        {draft.period === 'hours' && <label className="field" htmlFor="gwkey-hours">每多少小时
          <input className="input" id="gwkey-hours" type="number" min="1" max="8760" value={draft.hours}
            onChange={(e) => setDraft({ ...draft, hours: e.target.value })} />
        </label>}
        <label className="field" htmlFor="gwkey-tokens">Token 上限
          <input className="input" id="gwkey-tokens" type="number" min="0" step="1" placeholder="例如 100000000"
            value={draft.tokens} onChange={(e) => setDraft({ ...draft, tokens: e.target.value })} />
        </label>
        <label className="field" htmlFor="gwkey-cost">费用上限（美元）
          <input className="input" id="gwkey-cost" type="number" min="0" step="0.01" placeholder="例如 5"
            value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
        </label>
        <label className="plugin-toggle">
          <input type="checkbox" checked={draft.cacheReads}
            onChange={(e) => setDraft({ ...draft, cacheReads: e.target.checked })} />
          把缓存读取也算进 Token
        </label>
        <label className="field" htmlFor="gwkey-models">只统计这些模型（可选，逗号分隔）
          <input className="input" id="gwkey-models" placeholder="wanneng-lingxi/* 或 provider/model"
            value={draft.models} onChange={(e) => setDraft({ ...draft, models: e.target.value })} />
        </label>
        <div className="sub">Token 与费用至少填一个；留空表示不限制。每把 Key 最多 5 条额度，这里编辑主额度。</div>
      </Modal>}
    </>
  )
}
