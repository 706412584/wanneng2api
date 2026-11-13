// 模型列表：与「模型优先级」同一份数据（/api/magpie/model-catalog），换一种视图。
// 一行一个模型，显示有多少平台提供、最低倍率；展开看各平台与各自倍率。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from './Toast'
import { Empty, ErrorBox, Loading } from './Bits'

export default function ModelList() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState('')
  const [q, setQ] = useState('')
  const [onlyMulti, setOnlyMulti] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.modelCatalog())
      setError(null)
    } catch (e) {
      setError(e)
      toast(`读取模型目录失败：${e.message}`, 'err')
    } finally { setLoading(false) }
  }, [toast])

  // 进页面拉一次即可：目录要真实请求四家网关，不适合轮询
  useEffect(() => { load() }, [load])

  if (loading && !data) return <Loading text="聚合各平台模型与倍率…" />
  if (error && !data) return <ErrorBox error={error} onRetry={load} />

  const models = data?.models || []
  const needle = q.trim().toLowerCase()
  const shown = models.filter((m) => {
    if (onlyMulti && m.platformCount < 2) return false
    if (!needle) return true
    return m.name.toLowerCase().includes(needle)
      || m.platforms.some((p) => p.providerLabel.toLowerCase().includes(needle)
        || p.model.toLowerCase().includes(needle))
  })

  return (
    <>
      <div className="card-title" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <span>
          模型列表
          <span className="sub">{models.length} 个模型 · 按来源平台数排序</span>
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="搜索模型或平台"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="check-row" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyMulti} onChange={(e) => setOnlyMulti(e.target.checked)} />
            只看多平台
          </label>
          <button className="btn sm" onClick={load} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
        </span>
      </div>

      {(data?.warnings || []).length > 0 && (
        <div className="plugin-manager-error" style={{ marginBottom: 12 }}>
          部分平台倍率未能读取：{data.warnings.join('；')}
        </div>
      )}

      {!models.length && <Empty icon="◔" text="没有可路由的模型" />}

      {models.length > 0 && (
        <div className="table-wrap">
          <table className="tbl model-list">
            <thead>
              <tr>
                <th style={{ width: 32 }} />
                <th>模型</th>
                <th className="num" style={{ width: 96 }}>来源平台</th>
                <th style={{ width: 110 }}>最低倍率</th>
                <th style={{ width: 170 }}>最省平台</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const isOpen = open === m.key
                const badge = m.platforms.find((p) => p.badge)?.badge
                return (
                  <ModelRow
                    key={m.key}
                    m={m}
                    badge={badge}
                    isOpen={isOpen}
                    onToggle={() => setOpen(isOpen ? '' : m.key)}
                  />
                )
              })}
            </tbody>
          </table>
          {!shown.length && <Empty icon="⌕" text="没有匹配的模型" />}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.9 }}>
        倍率来自各网关自己的模型接口（WorkBuddy 的 credits、CodeArts 的 ratio_display、
        Lingxi 的 credits、Loomy 模型名里的括号）。<b>「—」是上游没有提供倍率，不等于 0</b>——
        0 表示免费。社区插件没有原生倍率接口，只能从模型名里的括号取，取不到同样显示「—」。
      </div>
    </>
  )
}

/** 一行模型 +（展开时）它的平台明细 */
function ModelRow({ m, badge, isOpen, onToggle }) {
  return (
    <>
      <tr
        className={`model-row ${isOpen ? 'open' : ''}`}
        onClick={onToggle}
        tabIndex={0}
        role="button"
        aria-expanded={isOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
        }}
      >
        <td><span className={`caret ${isOpen ? 'open' : ''}`} aria-hidden="true">▸</span></td>
        <td>
          <b>{m.name}</b>
          {badge && <span className="badge orange" style={{ marginLeft: 6 }}>{badge.text}</span>}
        </td>
        <td className="num">
          <span className={`badge ${m.platformCount > 1 ? 'purple' : 'gray'}`}>{m.platformCount}</span>
        </td>
        <td>
          {m.bestRatio === null ? (
            <span style={{ color: 'var(--text-3)' }}>—</span>
          ) : (
            <b style={{ color: m.bestRatio === 0 ? 'var(--green)' : undefined }}>
              {formatRatio(m.bestRatio)}
            </b>
          )}
        </td>
        <td>
          {m.bestProvider
            ? <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{m.bestProvider}</span>
            : <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>
      </tr>
      {isOpen && (
        <tr className="model-detail-row">
          <td />
          <td colSpan={4}>
            <div className="model-detail">
              {m.platforms.map((p) => (
                <div className="model-detail-item" key={`${p.provider}\u0000${p.model}`}>
                  <span className="model-detail-platform">
                    <b>{p.providerLabel}</b>
                    {p.off && <span className="badge gray">平台已禁用</span>}
                    {!p.native && <span className="badge gray" title="社区插件，无原生倍率接口">插件</span>}
                    {p.badge && <span className="badge orange">{p.badge.text}</span>}
                  </span>
                  <span className="mono model-detail-id" title="该平台上的模型 id">{p.model}</span>
                  <span className="model-detail-ratio">
                    {p.ratio === null
                      ? <span style={{ color: 'var(--text-3)' }}>倍率未提供</span>
                      : <b style={{ color: p.ratio === 0 ? 'var(--green)' : undefined }}>{formatRatio(p.ratio)}</b>}
                  </span>
                  {p.note && <span className="model-detail-note">{p.note}</span>}
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** 0 显示「免费」更直观；其余用倍率写法 */
export function formatRatio(n) {
  if (n === null || n === undefined) return '—'
  if (n === 0) return '免费'
  return `${n}x`
}