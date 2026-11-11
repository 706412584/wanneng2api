// 统一的操作加载遮罩。
// 用于所有「点了要等一会儿」的动作：平台启停/重启、安装插件、登录、更新内核…
// 之前只有按钮 disabled + 乐观更新，用户看不到任何进度，容易以为没反应。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const BusyCtx = createContext(null)

export function BusyProvider({ children }) {
  // tasks: [{ id, text, detail }]，支持多个动作叠加（显示最上面那个）
  const [tasks, setTasks] = useState([])
  const idRef = useRef(0)

  /**
   * 包住一个异步动作，期间显示遮罩。
   * @param {string} text 主文案，如「正在重启 WorkBuddy2API…」
   * @param {() => Promise<any>} fn 真正要做的事
   * @param {{detail?: string, minMs?: number}} [opts] 遮罩至少显示多久（避免闪一下）
   */
  const run = useCallback(async (text, fn, opts = {}) => {
    const id = ++idRef.current
    const minMs = opts.minMs ?? 450
    const startedAt = Date.now()
    setTasks((t) => [...t, { id, text, detail: opts.detail || '' }])
    try {
      return await fn()
    } finally {
      const rest = minMs - (Date.now() - startedAt)
      if (rest > 0) await new Promise((r) => setTimeout(r, rest))
      setTasks((t) => t.filter((x) => x.id !== id))
    }
  }, [])

  const value = useMemo(() => ({ tasks, run }), [tasks, run])
  const top = tasks[tasks.length - 1]

  return (
    <BusyCtx.Provider value={value}>
      {children}
      {top && (
        <div className="busy-mask" role="status" aria-live="polite">
          <div className="busy-box">
            <span className="spinner" />
            <div className="busy-text">{top.text}</div>
            {top.detail && <div className="busy-detail">{top.detail}</div>}
            {tasks.length > 1 && (
              <div className="busy-queue">还有 {tasks.length - 1} 个操作进行中</div>
            )}
          </div>
        </div>
      )}
    </BusyCtx.Provider>
  )
}

export function useBusy() {
  const ctx = useContext(BusyCtx)
  // 没有 Provider 时退化为直接执行，方便单测/局部渲染
  return ctx || { run: (_t, fn) => fn(), tasks: [] }
}

// ── 统一确认框 ──────────────────────────────────────────────────────
// 浏览器里 window.confirm 在 Electron 下会弹出很突兀的原生框，
// 而且不能自定义按钮文案；这里用 Promise 化的应用内确认框。
const ConfirmCtx = createContext(null)

export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null)
  const dialogRef = useRef(null)
  // 队列而非单槽：并发 confirm 时后一个不能覆盖前一个的 resolver，
  // 否则前一个 Promise 永远挂起，调用方一直停在“进行中”。
  const queue = useRef([])

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      queue.current.push({ resolve, ...opts, message })
      setReq(queue.current[0])
    })
  }, [])

  const settle = useCallback((value) => {
    const head = queue.current.shift()
    setReq(queue.current[0] || null)
    if (head) head.resolve(value)
  }, [])

  useEffect(() => {
    if (!req) return
    const previous = document.activeElement
    dialogRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(false) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      previous?.focus()
    }
  }, [req, settle])

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <div className="modal-mask" onClick={() => settle(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            tabIndex={-1}
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title" id="confirm-title">{req.title || '确认'}</div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {req.message}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => settle(false)}>{req.cancelText || '取消'}</button>
              <button className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => settle(true)}>
                {req.okText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmCtx) || ((msg) => Promise.resolve(window.confirm(msg)))
}