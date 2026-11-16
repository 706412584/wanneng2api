import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { useBusy, useConfirm } from '../components/Busy'
import { useToast } from '../components/Toast'
import { ErrorBox, Loading } from '../components/Bits'
import TunnelTargetCard from '../components/TunnelTargetCard'
import MagpieAliasSyncCard from '../components/MagpieAliasSyncCard'
import { fmtBytes } from '../utils/format'

const ACTIVE_PHASES = ['starting', 'reconnecting', 'stopping']

export default function ExternalAccess() {
  const fetchTunnels = useCallback(() => api.tunnels(), [])
  const [intervalMs, setIntervalMs] = useState(5000)
  const polling = usePolling(fetchTunnels, intervalMs)
  const { data, error, loading, refresh } = polling
  const toast = useToast()
  const confirm = useConfirm()
  const busy = useBusy()
  const [action, setAction] = useState('')
  const [preflight, setPreflight] = useState({})

  const targets = data?.targets || []
  const binary = data?.binary || {}
  const transitioning = targets.some((target) => ACTIVE_PHASES.includes(target.phase)) || binary.downloading
  useEffect(() => {
    setIntervalMs(transitioning ? 1000 : 5000)
  }, [transitioning])

  const run = async (key, text, fn) => {
    setAction(key)
    try {
      const result = await busy.run(text, fn)
      refresh()
      return result
    } catch (e) {
      toast(e.message, 'err')
      throw e
    } finally {
      setAction('')
    }
  }

  const handleInstall = () => run('binary', '正在下载并校验 cloudflared…', async () => {
    const result = await api.installTunnelBinary()
    toast('cloudflared 安装/修复已下发')
    return result
  }).catch(() => {})

  const handleSave = (target, patch) => run(`${target.id}:save`, `正在保存 ${target.name} 配置…`, async () => {
    const result = await api.saveTunnelConfig(target.id, patch)
    toast(`${target.name} 配置已保存`)
    return result
  })

  const handlePreflight = (target) => run(`${target.id}:preflight`, `正在检查 ${target.name}…`, async () => {
    try {
      const result = await api.preflightTunnel(target.id)
      setPreflight((current) => ({ ...current, [target.id]: { ok: true, message: `本机服务与凭据检查通过（HTTP ${result.targetStatus || 200}）` } }))
      toast(`${target.name} 预检通过`)
      return result
    } catch (e) {
      setPreflight((current) => ({ ...current, [target.id]: { ok: false, message: e.message } }))
      throw e
    }
  }).catch(() => {})

  const handleVerifyToken = (target, token) => run(`${target.id}:verify`, `正在验证 ${target.name} 的 Tunnel Token…`, async () => {
    const result = await api.verifyTunnelToken(target.id, token)
    toast(`${target.name} Token 验证通过，可继续配置 Public Hostname`)
    return result
  })

  const handleStart = async (target) => {
    const managerWarning = target.kind === 'manager'
      ? '这会开放完整管理权限，必须使用强密码并妥善保管公网地址。\n\n'
      : ''
    const ok = await confirm(`${managerWarning}确定通过 Cloudflare ${target.mode === 'quick' ? 'Quick Tunnel（临时地址）' : 'Named Tunnel（固定域名）'}开放 ${target.name} 吗？`, {
      title: '确认开启公网访问', okText: '开启外网访问', danger: target.kind === 'manager',
    })
    if (!ok) return
    return run(`${target.id}:start`, `正在建立 ${target.name} 公网隧道…`, async () => {
      const result = await api.startTunnel(target.id)
      toast(`${target.name} 隧道启动已下发，等待公网健康验证`)
      return result
    }).catch(() => {})
  }

  const handleStop = (target) => run(`${target.id}:stop`, `正在停止 ${target.name} 公网隧道…`, async () => {
    const result = await api.stopTunnel(target.id)
    toast(`${target.name} 公网入口已停止`)
    return result
  }).catch(() => {})

  const handlePassword = (target, value) => run(`${target.id}:password`, '正在更新远程管理密码…', async () => {
    if (value.newPassword.length < 12) throw new Error('新密码至少需要 12 位')
    if (value.newPassword !== value.confirmPassword) throw new Error('两次输入的新密码不一致')
    const result = await api.setTunnelManagerPassword(value.currentPassword, value.newPassword)
    toast('远程管理密码已更新，既有远程会话已注销')
    return result
  })

  if (loading && !data) return <Loading text="读取外网访问状态…" />
  if (error && !data) return <ErrorBox error={error} onRetry={refresh} />

  const percent = binary.total ? Math.min(100, (binary.received / binary.total) * 100) : null
  return (
    <>
      <div className="alert-bar muted">
        <span>外网访问由独立 Cloudflare Tunnel 模块管理，不修改 LAN 监听配置，也不会自动启动或重启既有网关。Quick 地址每次可能变化；Named Token 和域名需先在 Cloudflare 控制台配置。</span>
      </div>

      <section className="card">
        <div className="card-title tunnel-card-title">
          <span>cloudflared <span className="sub">固定版本与完整性校验</span></span>
          <span className={`badge ${binary.verified ? 'green' : binary.downloading ? 'orange' : 'gray'}`}>
            {binary.downloading ? '下载中' : binary.verified ? '已验证' : binary.installed ? '待校验' : '未安装'}
          </span>
        </div>
        <div className="tunnel-binary-row">
          <div className="grow">
            <div><b>版本 {binary.version || '—'}</b></div>
            <div className="sub">{binary.error || '启动隧道时会自动校验缓存；下载文件 SHA-256 不匹配时绝不执行。'}</div>
          </div>
          <button className="btn" disabled={action === 'binary' || binary.downloading} onClick={handleInstall}>
            {binary.downloading ? '正在下载…' : binary.installed ? '重新校验/修复' : '安装 cloudflared'}
          </button>
        </div>
        {binary.downloading && (
          <div className="tunnel-progress">
            <div className="progress">
              <div className={`bar ${percent == null ? 'updating' : ''}`} style={{ width: `${percent == null ? 100 : percent}%` }} />
            </div>
            <div className="sub">{fmtBytes(binary.received)}{binary.total ? ` / ${fmtBytes(binary.total)}` : ''}</div>
          </div>
        )}
      </section>

      <MagpieAliasSyncCard />

      <div className="tunnel-grid">
        {targets.map((target) => (
          <TunnelTargetCard
            key={target.id}
            target={target}
            action={action}
            preflight={preflight[target.id]}
            onSave={handleSave}
            onPreflight={handlePreflight}
            onVerifyToken={handleVerifyToken}
            onStart={handleStart}
            onStop={handleStop}
            onPassword={handlePassword}
          />
        ))}
      </div>
    </>
  )
}
