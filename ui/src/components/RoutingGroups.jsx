// 同模型跨平台优先级：一个模型被多个平台提供时，内核把它们合成一个路由组；
// 这里只调整成员顺序，不增删成员（增删仍在内核控制台做）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useToast } from './Toast'
import { ErrorBox, Loading } from './Bits'

/** 勾选顺序即优先级：新勾选的排在已选之后，取消则移除 */
function reorderPick(list, id, checked) {
  if (!checked) return list.filter((x) => x !== id)
  return list.includes(id) ? list : [...list, id]
}

/**
 * @param {object} [props]
 * @param {boolean} [props.embedded] 嵌入式（放进 Hub 的 tab）：不再自带 .card 外壳
 */
export default function RoutingGroups({ embedded = false }) {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState('')
  const [busy, setBusy] = useState(false)
  const [bindable, setBindable] = useState([])
  const [binding, setBinding] = useState(false)
  const [bindName, setBindName] = useState('')
  const [picked, setPicked] = useState([])
  const toast = useToast()
  // 用 ref 记录“是否已经有数据”，避免 load 闭包读到首次渲染的 groups
  const loadedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const r = await api.routingGroups()
      setGroups(r.groups || [])
      setBindable(r.bindable || [])
      setError(null)
      loadedRef.current = true
    } catch (e) {
      setError(e)
      // 已有数据时的刷新失败不能静默：用户会以为看到的是最新状态
      if (loadedRef.current) toast(`刷新失败：${e.message}`, 'err')
    }
    finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])

  const move = async (group, index, delta) => {
    const next = [...group.members]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    // 先本地生效，失败再回滚——顺序调整要立刻看到结果
    setGroups((list) => list.map((g) => (g.id === group.id ? { ...g, members: next } : g)))
    setBusy(true)
    try {
      const r = await api.reorderRoutingGroup(group.id, next)
      setGroups(r.groups || [])
      // 智能路由下顺序只是兜底：不夸大“已按此顺序调用”
      const saved = r.groups?.find((g) => g.id === group.id)
      const strict = saved?.routing === 'order'
      toast(strict
        ? `${group.name}：已按此顺序依次尝试`
        : `${group.name}：顺序已保存，但该组是智能路由，顺序只在条件相同时生效`)
    } catch (e) {
      toast(`保存顺序失败：${e.message}`, 'err')
      await load()
    } finally { setBusy(false) }
  }

  const saveBinding = async () => {
    if (busy) return
    if (!bindName.trim()) { toast('请填写分组名称', 'err'); return }
    if (!picked.length) { toast('请至少勾选一个平台', 'err'); return }
    setBusy(true)
    try {
      const r = await api.bindRoutingGroup({ name: bindName.trim(), providers: picked })
      setGroups(r.groups || [])
      setBinding(false)
      setBindName('')
      setPicked([])
      toast(`已创建入口「${r.saved?.name || bindName.trim()}」，共 ${r.saved?.members?.length || 0} 个模型`)
    } catch (e) { toast(`创建失败：${e.message}`, 'err') }
    finally { setBusy(false) }
  }

  if (loading && !groups) return <Loading text="读取跨平台路由组…" />
  if (error && !groups) return <ErrorBox error={error} onRetry={load} />

  const body = (
    <>
      <div className="card-title" style={{ justifyContent: 'space-between' }}>
        <span>同模型优先级 <span className="sub">多个平台提供同一模型时，按此顺序尝试</span></span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm primary" onClick={() => setBinding((v) => !v)} disabled={busy}>
            {binding ? '收起表单' : '新建入口绑定平台'}
          </button>
          <button className="btn sm" onClick={load} disabled={busy}>刷新</button>
        </span>
      </div>

      {binding && <div className="routing-bind">
        <label className="field" htmlFor="bind-name">分组名称
          <input className="input" id="bind-name" value={bindName} maxLength={80}
            placeholder="例如：主力入口" onChange={(e) => setBindName(e.target.value)} />
        </label>
        <div className="field">
          <span>选择平台 <span className="desc">按勾选顺序依次尝试；每个平台会带上它已启用的全部模型</span></span>
          <div className="routing-bind-list">
            {bindable.map((p) => <label key={p.id} className={`routing-bind-item ${picked.includes(p.id) ? 'selected' : ''}`}>
              <input type="checkbox" checked={picked.includes(p.id)} disabled={p.off || !p.models.length}
                onChange={(e) => setPicked((list) => reorderPick(list, p.id, e.target.checked))} />
              <span>
                <b>{p.name}</b>
                <span className="sub">{p.off ? '平台已禁用' : p.models.length ? `${p.models.length} 个已启用模型` : '没有已启用的模型'}</span>
              </span>
              {picked.includes(p.id) && <span className="badge purple">第 {picked.indexOf(p.id) + 1} 位</span>}
            </label>)}
          </div>
        </div>
        <div className="plugin-manager-save">
          <span className="sub">已选 {picked.length} 个平台</span>
          <button className="btn primary" disabled={busy || !picked.length || !bindName.trim()} onClick={saveBinding}>
            {busy ? '创建中…' : '创建入口'}
          </button>
        </div>
      </div>}

      {!groups.length && !binding && <div className="plugin-manager-empty">当前没有多个平台共用的模型。</div>}
      <div className="routing-group-list">
        {groups.map((g) => (
          <div className="routing-group" key={g.id}>
            <button
              className="routing-group-head"
              aria-expanded={open === g.id}
              aria-controls={`rg-${g.id}`}
              onClick={() => setOpen(open === g.id ? '' : g.id)}
            >
              <span className={`caret ${open === g.id ? 'open' : ''}`} aria-hidden="true">▸</span>
              <b className="ellipsis" title={g.name}>{g.name}</b>
              <span className="sub">{g.members.length} 个平台{g.auto ? ' · 自动合并' : ' · 已自定义'}</span>
              {/* 空 routing = 智能调度；只有空与 order 才能调顺序 */}
              {!g.routing && <span className="badge blue" title="智能路由：按额度与续期自动挑选；顺序只在条件相同时生效">智能</span>}
              {g.routing && g.routing !== 'order'
                && <span className="badge gray" title="该策略不看成员顺序，调整顺序不会生效">{g.routing}</span>}
            </button>
            {open === g.id && <ol className="routing-group-members" id={`rg-${g.id}`}>
              {g.members.map((id, i) => {
                const info = g.memberInfo.find((m) => m.id === id) || {}
                return <li key={id} className="routing-member">
                  <span className="routing-rank">{i + 1}</span>
                  <span className="routing-member-name">
                    <b>{info.name || info.provider || id.split('/')[0]}</b>
                    <span className="mono sub">{id}</span>
                  </span>
                  {info.providerOff && <span className="badge gray">平台已禁用</span>}
                  <span className="routing-member-actions">
                    <button className="btn sm" disabled={busy || i === 0} onClick={() => move(g, i, -1)} aria-label="上移">↑</button>
                    <button className="btn sm" disabled={busy || i === g.members.length - 1} onClick={() => move(g, i, 1)} aria-label="下移">↓</button>
                  </span>
                </li>
              })}
            </ol>}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.8 }}>
        排在前面的平台先被尝试；失败或被限流才轮到下一个。
        修改自动合并组后，该组会变成你的自定义组，内核不会再自动增删成员。
      </div>
    </>
  )
  return embedded ? body : <div className="card">{body}</div>
}