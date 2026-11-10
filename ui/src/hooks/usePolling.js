// 轮询 hook：fn 变化或 interval 变化时重建定时器；卸载时清理
import { useEffect, useRef, useState } from 'react'

/**
 * @param {() => Promise<any>} fn 轮询函数（需稳定引用或自行用 useCallback）
 * @param {number} intervalMs 轮询间隔毫秒；0 表示不轮询只取一次
 * @param {boolean} enabled 是否启用
 * @returns {{ data: any, error: Error|null, loading: boolean, refresh: () => void }}
 */
export function usePolling(fn, intervalMs = 0, enabled = true) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const tickRef = useRef(0)

  const run = async () => {
    if (!enabled) return
    try {
      const d = await fnRef.current()
      setData(d)
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    setLoading(true)
    run()
    if (!intervalMs) return
    const timer = setInterval(() => { run() }, intervalMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, tickRef.current])

  const refresh = () => { tickRef.current++; run() }

  return { data, error, loading, refresh }
}
