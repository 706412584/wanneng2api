// 日志页：平台多选 + SSE 实时流（自动滚动可暂停）+ 级别过滤 + 搜索
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, openLogStream } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Empty, ErrorBox, Loading } from '../components/Bits'

const LEVELS = ['ALL', 'INFO', 'WARN', 'ERROR']
const MAX_LINES = 2000

export default function Logs() {
  const [params] = useSearchParams()
  const fetchPlatforms = useCallback(() => api.listPlatforms(), [])
  const pf = usePolling(fetchPlatforms, 10000)

  const platforms = pf.data || []
  const [selected, setSelected] = useState(() => {
    const q = params.get('id')
    return q ? [q] : []
  })
  const [lines, setLines] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [paused, setPaused] = useState(false)
  const [level, setLevel] = useState('ALL')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)

  const boxRef = useRef(null)
  const pausedBufRef = useRef([])
  const streamStopRef = useRef(null)

  // 默认全选（平台列表首次加载后）
  useEffect(() => {
    if (!selected.length && platforms.length) {
      setSelected(params.get('id') ? [params.get('id')] : platforms.map((p) => p.id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platforms.length])

  // SSE 连接管理：选中平台变化 / 暂停切换时重建
  useEffect(() => {
    if (streamStopRef.current) { streamStopRef.current(); streamStopRef.current = null }
    if (!streaming || !selected.length) return
    const stop = openLogStream(selected, ({ id, text }) => {
      if (paused) {
        pausedBufRef.current.push({ id, text, ts: Date.now() })
        if (pausedBufRef.current.length > 500) pausedBufRef.current.shift()
      } else {
        setLines((prev) => {
          const next = prev.concat({ id, text, ts: Date.now() })
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
        })
      }
    })
    streamStopRef.current = stop
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, selected.join(','), paused])

  // 恢复时回放暂停期缓冲
  useEffect(() => {
    if (!paused && pausedBufRef.current.length) {
      const buf = pausedBufRef.current
      pausedBufRef.current = []
      setLines((prev) => {
        const next = prev.concat(buf)
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
      })
    }
  }, [paused])

  // 自动滚动
  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const togglePlatform = (id) => {
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.concat(id)))
  }

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return lines.filter((l) => {
      if (level !== 'ALL' && !lineLevel(l.text).includes(level)) return false
      if (kw && !l.text.toLowerCase().includes(kw) && !l.id.toLowerCase().includes(kw)) return false
      return true
    })
  }, [lines, level, search])

  if (pf.loading && !pf.data) return <Loading text="加载平台列表…" />
  if (pf.error && !pf.data) return <ErrorBox error={pf.error} onRetry={pf.refresh} />

  return (
    <>
      <div className="card">
        <div className="log-toolbar">
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>平台</span>
          <div className="checkbox-group">
            {platforms.map((p) => (
              <label className="check-row" key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={() => togglePlatform(p.id)}
                />
                {p.name}
              </label>
            ))}
          </div>
        </div>
        <div className="log-toolbar" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {LEVELS.map((lv) => (
              <button
                key={lv}
                className={`btn sm${level === lv ? ' primary' : ''}`}
                onClick={() => setLevel(lv)}
              >
                {lv === 'ALL' ? '全部' : lv}
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="搜索日志内容 / 平台名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span style={{ flex: 1 }} />
          <button
            className={`btn ${streaming ? 'danger' : 'primary'}`}
            disabled={!selected.length}
            onClick={() => {
              if (streaming) { setStreaming(false); setLines([]) }
              else { setLines([]); pausedBufRef.current = []; setStreaming(true) }
            }}
          >
            {streaming ? '停止并清空' : '开始监听'}
          </button>
          <button className="btn" disabled={!streaming} onClick={() => setPaused((v) => !v)}>
            {paused ? '继续滚动' : '暂停滚动'}
          </button>
          <label className="check-row">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
        </div>
        {!selected.length && <div className="alert-bar" style={{ marginTop: 10 }}>请至少选择一个平台</div>}
        {paused && <div className="alert-bar" style={{ marginTop: 10 }}>已暂停滚动 —— 新日志在后台缓冲（最多 500 条），点「继续滚动」回放</div>}
      </div>

      <div className="log-stream" ref={boxRef}>
        {filtered.length === 0 && (
          <div className="empty" style={{ height: '100%' }}>
            <div className="big">▥</div>
            <div>{streaming ? '已连接，等待日志输出…' : '选择平台后点击「开始监听」'}</div>
          </div>
        )}
        {filtered.map((l, i) => {
          const lv = lineLevel(l.text)
          return (
            <div className={`log-line lv-${lv}`} key={`${l.ts}-${i}`}>
              <span className="lid">{l.id}</span>
              <span className="lt">{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{highlight(l.text, search)}</span>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', gap: 14 }}>
        <span>缓冲 {lines.length} 行（上限 {MAX_LINES}）</span>
        <span>过滤后 {filtered.length} 行</span>
        {streaming && <span style={{ color: paused ? 'var(--orange)' : 'var(--green)' }}>● {paused ? '已暂停' : '实时接收中'}</span>}
      </div>
    </>
  )
}

/** 从日志行提取级别（INFO/WARN/ERROR/DEBUG 关键词匹配） */
function lineLevel(text) {
  if (/\b(ERROR|FATAL|panic|failed)\b/i.test(text)) return 'ERROR'
  if (/\b(WARN|WARNING)\b/i.test(text)) return 'WARN'
  if (/\bDEBUG\b/i.test(text)) return 'DEBUG'
  return 'INFO'
}

/** 搜索关键词高亮 */
function highlight(text, kw) {
  const k = kw.trim()
  if (!k) return text
  const idx = text.toLowerCase().indexOf(k.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'color-mix(in srgb, var(--yellow) 45%, transparent)', color: 'inherit', borderRadius: 2 }}>
        {text.slice(idx, idx + k.length)}
      </mark>
      {text.slice(idx + k.length)}
    </>
  )
}
