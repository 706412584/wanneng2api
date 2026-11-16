import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useConfirm } from './Busy'
import { useToast } from './Toast'
import Modal from './Modal'
import { fmtDateTime } from '../utils/format'

const ACTIVE_PHASES = ['starting', 'running', 'reconnecting', 'stopping']
const PHASE_TEXT = {
  stopped: '已停止', starting: '启动中', running: '已上线',
  reconnecting: '重连中', stopping: '停止中', error: '错误',
}
const STAGE_TEXT = {
  idle: '', preflight: '检查前置条件', gateway: '启动本机安全入口', downloading: '准备 cloudflared',
  spawning: '启动隧道进程', registering: '等待 Cloudflare 注册', 'checking-public': '验证公网地址', 'waiting-target': '等待目标服务',
}

function toDraft(target) {
  return {
    mode: target.mode || 'quick',
    autoStart: !!target.autoStart,
    publicUrl: target.configuredPublicUrl || '',
    guardPort: target.guardPort || Number(target.guardUrl?.split(':').pop()) || 0,
    token: '',
    clearToken: false,
  }
}

function phaseClass(phase) {
  if (phase === 'running') return 'healthy'
  if (phase === 'error') return 'error'
  if (phase === 'reconnecting') return 'degraded'
  if (phase === 'starting' || phase === 'stopping') return 'starting'
  return 'stopped'
}

export default function TunnelTargetCard({ target, action, preflight, onSave, onPreflight, onVerifyToken, onStart, onStop, onPassword }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [draft, setDraft] = useState(() => toDraft(target))
  const [dirty, setDirty] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [verification, setVerification] = useState(null)
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const active = ACTIVE_PHASES.includes(target.phase)
  const busyForCard = action.startsWith(`${target.id}:`)
  const disabled = busyForCard || target.phase === 'stopping'

  useEffect(() => {
    if (!dirty) setDraft(toDraft(target))
  }, [target.updatedAt, target.mode, target.configuredPublicUrl, target.guardPort, target.autoStart, dirty])

  const fetchLogs = useCallback(() => api.tunnelLogs(target.id, 200), [target.id])
  const logs = usePolling(fetchLogs, showLogs ? 3000 : 0, showLogs)

  const update = (key, value) => {
    if (key === 'token' || key === 'clearToken') setVerification(null)
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
  }

  const changedPatch = (value = draft) => {
    const patch = {}
    if (value.mode !== target.mode) patch.mode = value.mode
    if (value.autoStart !== !!target.autoStart) patch.autoStart = value.autoStart
    if (value.publicUrl !== (target.configuredPublicUrl || '')) patch.publicUrl = value.publicUrl
    if (value.guardPort !== (target.guardPort || Number(target.guardUrl?.split(':').pop()) || 0)) patch.guardPort = Number(value.guardPort)
    if (value.clearToken) patch.token = ''
    else if (value.token) patch.token = value.token
    return patch
  }

  const handleCloseConfig = useCallback(async () => {
    if (dirty) {
      const ok = await confirm('配置尚未保存，关闭弹窗将放弃这些修改。', { title: '放弃未保存的配置？', okText: '放弃修改', danger: true })
      if (!ok) return
    }
    setDirty(false)
    setDraft(toDraft(target))
    setShowConfig(false)
    setVerification(null)
    setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' })
  }, [confirm, dirty, target])

  const handleSave = async () => {
    const patch = changedPatch()
    try {
      if (Object.keys(patch).length) await onSave(target, patch)
      setDraft(toDraft({ ...target, ...patch, configuredPublicUrl: patch.publicUrl ?? target.configuredPublicUrl }))
      setDirty(false)
      setShowConfig(false)
    setVerification(null)
    setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' })
    } catch { /* 保留弹窗与草稿，便于修正后重试 */ }
  }

  const handleVerifyToken = async () => {
    try {
      const result = await onVerifyToken(target, draft.token)
      setVerification(result)
      const nextDraft = { ...draft, token: '' }
      setDraft(nextDraft)
      setDirty(Object.keys(changedPatch(nextDraft)).length > 0)
    } catch (error) {
      setVerification({ ok: false, message: error.message })
    }
  }

  const handlePassword = async () => {
    try {
      await onPassword(target, password)
      setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' })
    } catch { /* 密码输入只在成功时清空 */ }
  }

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value)
      toast('已复制')
    } catch (e) {
      toast(`复制失败：${e.message}`, 'err')
    }
  }

  const named = draft.mode === 'named'
  const verifiedInfo = verification || (!draft.token && !draft.clearToken
    ? (target.verifiedAt
      ? { ok: true, verifiedAt: target.verifiedAt, tunnelId: target.tunnelId }
      : target.verificationError
        ? { ok: false, message: target.verificationError.message }
        : null)
    : null)
  const isVerified = !!verifiedInfo?.ok && !draft.token && !draft.clearToken && target.hasToken
  const startDisabled = disabled || active || (target.kind === 'manager' && !target.passwordConfigured)
    || (target.mode === 'named' && !(target.verifiedAt > 0))
  const phase = target.phase || 'stopped'
  const stageText = STAGE_TEXT[target.stage]

  return (
    <>
      <section className="card tunnel-card">
        <div className="card-title tunnel-card-title">
          <span>{target.name}</span>
          <span className={`state-pill ${phaseClass(phase)}`}>
            <span className={`dot ${phaseClass(phase)}`} />
            {PHASE_TEXT[phase] || phase}
          </span>
        </div>
        <div className="sub tunnel-card-sub">
          {target.kind === 'manager' ? '完整远程管理台' : `模型 API · 原端口 ${target.upstreamPort}`}
          {stageText && phase !== 'running' ? ` · ${stageText}` : ''}
        </div>

        <div className="tunnel-status-row">
          <span>本机：<b className={target.localHealth === 'ok' ? 'text-ok' : target.localHealth === 'failed' ? 'text-err' : ''}>{target.localHealth || 'unknown'}</b></span>
          <span>公网：<b className={target.publicHealth === 'ok' ? 'text-ok' : ['failed', 'degraded'].includes(target.publicHealth) ? 'text-err' : ''}>{target.publicHealth || 'unknown'}</b></span>
          <span>自动恢复：{target.autoStart ? '开' : '关'}</span>
          {target.kind === 'manager' && <span>密码：{target.passwordConfigured ? '已设置' : '未设置'}</span>}
        </div>

        <div className="field tunnel-public-field">
          <label>当前公网 Base URL</label>
          <div className="copy-box">
            <span className="val">{target.publicUrl || '尚未开放'}</span>
            {target.publicUrl && <button className="btn sm ghost" onClick={() => copy(target.publicUrl)}>复制</button>}
          </div>
        </div>

        {target.lastError && (
          <div className="tunnel-error tunnel-error-clamp" role="alert" title={`${target.lastError.code}: ${target.lastError.message}`}>
            <b>{target.lastError.code}</b>：{target.lastError.message}
            {target.nextRetryAt > 0 && <span> · 下次重试 {fmtDateTime(target.nextRetryAt)}</span>}
          </div>
        )}

        <div className="tunnel-actions">
          <button className="btn sm" disabled={disabled} onClick={() => setShowConfig(true)}>配置</button>
          <button className="btn sm" disabled={disabled} onClick={() => onPreflight(target)}>预检</button>
          {active || target.desiredRunning ? (
            <button className="btn sm danger" disabled={disabled} onClick={() => onStop(target)}>
              {target.phase === 'stopping' ? '停止中…' : '停止'}
            </button>
          ) : (
            <button className="btn sm primary" disabled={startDisabled} onClick={() => onStart(target)}>
              {target.phase === 'starting' ? '启动中…' : '开启'}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => setShowLogs(true)}>日志</button>
        </div>
      </section>

      {showConfig && (
        <Modal
          title={`配置 · ${target.name}`}
          onClose={handleCloseConfig}
          footer={(
            <>
              <button className="btn ghost" onClick={handleCloseConfig}>取消</button>
              <button className="btn" disabled={disabled || dirty} onClick={() => onPreflight(target)}>预检</button>
              <button className="btn primary" disabled={disabled || (!dirty && !Object.keys(changedPatch()).length)} onClick={handleSave}>保存配置</button>
            </>
          )}
        >
          <div className="form-grid">
            <div className="field">
              <label>隧道模式</label>
              <select className="select" value={draft.mode} disabled={active || disabled} onChange={(e) => update('mode', e.target.value)}>
                <option value="quick">Quick · 临时公网地址</option>
                <option value="named">Named · 自有固定域名</option>
              </select>
            </div>
            <div className="field">
              <label>本机安全入口端口</label>
              <input className="input" type="number" min={1024} max={65535} value={draft.guardPort}
                disabled={active || disabled} onChange={(e) => update('guardPort', Number(e.target.value) || 0)} />
            </div>
          </div>

          {named && (
            <>
              <div className="form-grid">
                <div className="field">
                  <label>Tunnel Token <span className="desc">{target.hasToken ? '已保存；留空保持不变' : '只写入，不回显'}</span></label>
                  <input className="input" type="password" placeholder={target.hasToken ? '输入新 Token 以替换' : '粘贴 Cloudflare Tunnel Token'}
                    value={draft.token} disabled={active || disabled || draft.clearToken} autoComplete="off"
                    onChange={(e) => update('token', e.target.value)} />
                  {target.hasToken && !active && (
                    <label className="check-row">
                      <input type="checkbox" checked={draft.clearToken} onChange={(e) => update('clearToken', e.target.checked)} />
                      清除已保存 Token
                    </label>
                  )}
                  <div className="tunnel-token-actions">
                    <button className="btn sm" disabled={active || disabled || draft.clearToken || (!draft.token && !target.hasToken) || target.verifyingToken} onClick={handleVerifyToken}>
                      {target.verifyingToken ? '验证中…' : isVerified ? '重新验证' : '验证 Token'}
                    </button>
                    {!verifiedInfo && <span className="sub">先验证 Token，再配置域名与路由</span>}
                  </div>
                </div>
                <div className="field">
                  <label>Public Hostname <span className="desc">{isVerified ? '仅 https://域名，不带路径' : '验证 Token 后开放'}</span></label>
                  <input className="input" type="url" placeholder="https://api.example.com" value={draft.publicUrl}
                    disabled={active || disabled || !isVerified} onChange={(e) => update('publicUrl', e.target.value)} />
                </div>
              </div>
              {verifiedInfo && (
                <div className={verifiedInfo.ok ? 'tunnel-preflight ok' : 'tunnel-preflight err'}>
                  {verifiedInfo.ok
                    ? `Token 已验证${verifiedInfo.tunnelId ? ` · Tunnel ${verifiedInfo.tunnelId}` : ''}${verifiedInfo.verifiedAt ? ` · ${fmtDateTime(verifiedInfo.verifiedAt)}` : ''}`
                    : `验证失败：${verifiedInfo.message}`}
                </div>
              )}
              {!verifiedInfo && draft.token && <div className="sub tunnel-draft-warning">新 Token 尚未验证，请先完成验证。</div>}
            </>
          )}

          <label className="check-row">
            <input type="checkbox" checked={draft.autoStart} disabled={disabled} onChange={(e) => update('autoStart', e.target.checked)} />
            壳启动时自动恢复此隧道（不会自动启动目标平台）
          </label>

          <div className="field">
            <label>Cloudflare Service URL <span className="desc">Named 模式在 Cloudflare 控制台中填写此地址</span></label>
            <div className="copy-box">
              <span className="val">{target.guardUrl}</span>
              <button className="btn sm ghost" onClick={() => copy(target.guardUrl)}>复制</button>
            </div>
          </div>

          {target.kind === 'manager' && (
            <div className="tunnel-password">
              <div className="sub"><b>远程管理密码</b> · {target.passwordConfigured ? '已设置；修改后全部远程会话失效' : '启动前必须设置'}</div>
              <div className="form-grid">
                {target.passwordConfigured && (
                  <div className="field">
                    <label>当前密码</label>
                    <input className="input" type="password" value={password.currentPassword} autoComplete="current-password"
                      onChange={(e) => setPassword((current) => ({ ...current, currentPassword: e.target.value }))} />
                  </div>
                )}
                <div className="field">
                  <label>新密码（至少 12 位）</label>
                  <input className="input" type="password" value={password.newPassword} autoComplete="new-password"
                    onChange={(e) => setPassword((current) => ({ ...current, newPassword: e.target.value }))} />
                </div>
                <div className="field">
                  <label>确认新密码</label>
                  <input className="input" type="password" value={password.confirmPassword} autoComplete="new-password"
                    onChange={(e) => setPassword((current) => ({ ...current, confirmPassword: e.target.value }))} />
                </div>
              </div>
              <button className="btn sm" disabled={disabled || !password.newPassword} onClick={handlePassword}>
                {target.passwordConfigured ? '修改密码' : '设置密码'}
              </button>
            </div>
          )}

          {preflight && <div className={preflight.ok ? 'tunnel-preflight ok' : 'tunnel-preflight err'}>{preflight.message}</div>}
          {dirty && <div className="sub tunnel-draft-warning">有未保存的修改；保存后才能预检。</div>}
        </Modal>
      )}

      {showLogs && (
        <Modal title={`日志 · ${target.name}`} onClose={() => setShowLogs(false)} wide>
          <div className="log-stream tunnel-log-stream">
            {(logs.data?.lines || []).map((line, index) => <div className="log-line" key={`${index}:${line}`}>{line}</div>)}
            {!logs.data?.lines?.length && <div className="log-line">暂无日志</div>}
          </div>
        </Modal>
      )}
    </>
  )
}
