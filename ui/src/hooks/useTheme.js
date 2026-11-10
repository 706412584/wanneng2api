// 主题切换：浅/深/跟随系统（CSS 变量实现），持久化到 localStorage
import { useCallback, useEffect, useState } from 'react'

const KEY = 'w2a-theme' // 'light' | 'dark' | 'auto'

function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(mode) {
  const effective = mode === 'auto' ? (systemDark() ? 'dark' : 'light') : mode
  document.documentElement.setAttribute('data-theme', effective)
}

export function useTheme() {
  const [mode, setMode] = useState(() => localStorage.getItem(KEY) || 'auto')

  useEffect(() => {
    apply(mode)
    localStorage.setItem(KEY, mode)
  }, [mode])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if ((localStorage.getItem(KEY) || 'auto') === 'auto') apply('auto') }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const cycle = useCallback(() => {
    setMode((m) => (m === 'auto' ? 'light' : m === 'light' ? 'dark' : 'auto'))
  }, [])

  return { mode, setMode, cycle }
}
