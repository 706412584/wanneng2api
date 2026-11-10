// 共享小组件：状态灯 / 空态 / 加载态 / 错误态
import { fmtUptime } from '../utils/format'

export const STATE_TEXT = {
  stopped: '已停止',
  starting: '启动中',
  healthy: '健康',
  degraded: '降级',
  unhealthy: '异常',
  error: '错误',
  updating: '更新中'
}

export function StateDot({ state, size }) {
  return <span className={`dot ${state || 'stopped'}`} style={size ? { width: size, height: size } : undefined} />
}

export function StatePill({ state }) {
  return (
    <span className={`state-pill ${state || ''}`}>
      <StateDot state={state} size={7} />
      {STATE_TEXT[state] || state}
    </span>
  )
}

export function Uptime({ sec }) {
  return <>{fmtUptime(sec)}</>
}

export function Loading({ text = '加载中…' }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span>{text}</span>
    </div>
  )
}

export function Empty({ icon = '📭', text = '暂无数据' }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{text}</div>
    </div>
  )
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="error-box">
      <div style={{ fontSize: 26 }}>⚠️</div>
      <div>加载失败：{error?.message || String(error)}</div>
      {onRetry && (
        <button className="btn" onClick={onRetry}>重试</button>
      )}
    </div>
  )
}
