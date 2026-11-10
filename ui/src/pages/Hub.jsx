// Hub 页：统一入口（base_url + api_key 遮罩 + 复制）+ 模型路由表 + 上游健康表 + 实时用量表 + 热重载
import { useCallback, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useToast } from '../components/Toast'
import { Empty, ErrorBox, Loading, StateDot, STATE_TEXT } from '../components/Bits'
import { fmtNum, fmtTime } from '../utils/format'

export default function Hub() {
  const fetchHub = useCallback(() => api.hubStatus(), [])
  const { data, error, loading, refresh } = usePolling(fetchHub, 5000)
  const toast = useToast()
  const [showKey, setShowKey] = useState(false)
  const [reloading, setReloading] = useState(false)

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${label} 已复制到剪贴板`)
    } catch {
      // 剪贴板 API 失败（非 https / 无权限）时降级 execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        toast(`${label} 已复制到剪贴板`)
      } catch (e) {
        toast(`复制失败：${e.message}`, 'err')
      }
    }
  }

  const reload = async () => {
    setReloading(true)
    try {
      await api.hubReload()
      toast('hub.json 热重载成功')
      refresh()
    } catch (e) {
      toast(`热重载失败：${e.message}`, 'err')
    } finally {
      setReloading(false)
    }
  }

  if (loading && !data) return <Loading text="加载 Hub 状态…" />
  if (error && !data) return <ErrorBox error={error} onRetry={refresh} />
  if (!data) return <Empty />

  const hubState = data.state || 'stopped'

  return (
    <>
      <div className="card">
        <div className="card-title" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            统一入口
            <span className={`state-pill ${hubState}`}>
              <StateDot state={hubState} size={7} />
              {STATE_TEXT[hubState] || hubState}
            </span>
          </span>
          <button className="btn" disabled={reloading} onClick={reload}>{reloading ? '重载中…' : '热重载配置'}</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CopyRow label="Base URL" value={data.baseUrl} masked={false} onCopy={copy} />
          <CopyRow label="API Key" value={data.apiKey} masked={!showKey} onCopy={copy}
            extra={
              <button className="btn sm ghost" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
            }
          />
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            客户端（Claude Code / OpenAI SDK）只需配置以上 base_url 与 api_key；Hub 按模型路由到各平台并自动故障转移。监听地址 {data.listen}。
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        <div className="card">
          <div className="card-title">模型路由表 <span className="sub">模式 → 平台链（按优先级）</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>模型模式</th><th>平台链</th></tr>
              </thead>
              <tbody>
                {(data.modelRoutes || []).map((r) => (
                  <tr key={r.pattern}>
                    <td className="num">{r.pattern}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {r.chain.map((id, i) => (
                          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {i > 0 && <span style={{ color: 'var(--text-3)' }}>→</span>}
                            <span className="badge blue">{id}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!(data.modelRoutes || []).length && <Empty icon="⇄" text="路由表为空" />}
        </div>

        <div className="card">
          <div className="card-title">上游健康 <span className="sub">冷却中的上游自动跳过</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>上游</th><th>地址</th><th>优先级</th><th>状态</th><th>冷却</th></tr>
              </thead>
              <tbody>
                {(data.upstreams || []).map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.id}</b>{!u.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>未启用</span>}</td>
                    <td className="num">{u.baseUrl}</td>
                    <td className="num">{u.priority}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StateDot state={u.state} size={7} />
                        {STATE_TEXT[u.state] || u.state}
                      </span>
                    </td>
                    <td>{u.cooldownSec > 0 ? <span className="badge red">{u.cooldownSec}s</span> : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">实时用量 <span className="sub">最近 20 条 · 每 5 秒刷新</span></div>
        <UsageTable rows={data.usage || []} />
      </div>
    </>
  )
}

function CopyRow({ label, value, masked, onCopy, extra }) {
  const shown = masked ? 'sk-wanneng-' + '•'.repeat(18) : value
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr auto auto', gap: 8, alignItems: 'center' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600 }}>{label}</span>
      <div className="copy-box"><span className="val">{shown}</span></div>
      {extra}
      <button className="btn sm" onClick={() => onCopy(value, label)}>复制</button>
    </div>
  )
}

function UsageTable({ rows }) {
  if (!rows.length) return <Empty icon="▥" text="暂无用量记录（发起一次请求后出现）" />
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>时间</th><th>上游</th><th>模型</th><th>状态</th>
            <th>TTFB</th><th>总耗时</th><th>Prompt</th><th>Completion</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((u, i) => (
            <tr key={`${u.ts}-${i}`}>
              <td className="num">{fmtTime(u.ts)}</td>
              <td><span className="badge blue">{u.upstream}</span></td>
              <td className="num" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.model}</td>
              <td>{u.status === 200 ? <span className="badge green">{u.status}</span> : <span className="badge red">{u.status}</span>}</td>
              <td className="num">{u.ttfbMs}ms</td>
              <td className="num">{(u.latencyMs / 1000).toFixed(1)}s</td>
              <td className="num">{fmtNum(u.promptTokens)}</td>
              <td className="num">{fmtNum(u.completionTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
