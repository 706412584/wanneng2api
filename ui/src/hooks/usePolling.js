// 轮询 hook：请求完成后才安排下一次，旧响应不得覆盖新状态
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * @param {() => Promise<any>} fn 轮询函数（需稳定引用或自行用 useCallback）
 * @param {number} intervalMs 轮询间隔毫秒；0 表示不轮询只取一次
 * @param {boolean} enabled 是否启用
 * @returns {{ data: any, error: Error|null, loading: boolean, refresh: () => void, setData: Function }}
 */
export function usePolling(fn, intervalMs = 0, enabled = true) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  const runRef = useRef(null)
  const scheduleRef = useRef(null)
  const timerRef = useRef(null)
  const mountedRef = useRef(true)
  const enabledRef = useRef(enabled)
  const intervalRef = useRef(intervalMs)
  const generationRef = useRef(0)
  const inFlightRef = useRef(0)
  const queuedRef = useRef(false)

  fnRef.current = fn
  enabledRef.current = enabled
  intervalRef.current = intervalMs

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const run = useCallback(async () => {
    if (!enabledRef.current) return
    if (inFlightRef.current) {
      queuedRef.current = true
      return
    }
    const generation = ++generationRef.current
    inFlightRef.current = generation
    try {
      const result = await fnRef.current()
      if (mountedRef.current && generation === generationRef.current && enabledRef.current) {
        setData(result)
        setError(null)
      }
    } catch (e) {
      if (mountedRef.current && generation === generationRef.current && enabledRef.current) setError(e)
    } finally {
      if (inFlightRef.current === generation) inFlightRef.current = 0
      if (mountedRef.current && generation === generationRef.current) setLoading(false)
      if (queuedRef.current) {
        queuedRef.current = false
        if (mountedRef.current && enabledRef.current) runRef.current()
      } else if (scheduleRef.current) {
        scheduleRef.current()
      }
    }
  }, [])
  runRef.current = run

  scheduleRef.current = () => {
    clearTimer()
    if (!enabledRef.current || !intervalRef.current || !mountedRef.current) return
    timerRef.current = setTimeout(() => runRef.current(), intervalRef.current)
  }

  useEffect(() => {
    generationRef.current++
    clearTimer()
    queuedRef.current = false
    if (!enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    run()
    return () => {
      generationRef.current++
      clearTimer()
    }
  }, [intervalMs, enabled, run])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current++
      clearTimer()
    }
  }, [])

  const refresh = useCallback(() => {
    clearTimer()
    runRef.current()
  }, [])

  return { data, error, loading, refresh, setData }
}
