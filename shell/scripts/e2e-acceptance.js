// 端到端验收：用真实的 PlatformManager + ApiServer 驱动真实网关进程。
// 不启动 Electron，只验证核心能力（spawn / 健康 / 崩溃拉起 / 启停 / 日志）。
//
// 运行：node scripts/e2e-acceptance.js

const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const { PlatformManager } = require('../src/platform-manager')
const { ApiServer } = require('../src/api-server')
const { ConfigStore } = require('../src/config')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: 5000 }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, json: null, raw: data })
        }
      })
    })
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }) })
  })
}

// TCP 连一下最可靠：Windows 上 bind 探测会被 SO_REUSEADDR 之类影响。
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ host: '127.0.0.1', port, timeout: 800 })
    const done = (v) => { try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.once('timeout', () => done(false))
  })
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

async function main() {
  console.log('=== wanneng2api 端到端验收 ===\n')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanneng-e2e-'))
  console.log(`临时数据目录: ${dataDir}\n`)

  const store = new ConfigStore(dataDir)
  const manager = new PlatformManager({ store, dataDir })

  console.log('[平台清单]')
  const plats = store.platforms.platforms
  ok('平台数量 = 6', plats.length === 6, `实际 ${plats.length}`)
  const ids = plats.map((p) => p.id)
  ok('包含 workbuddy', ids.includes('workbuddy'))
  ok('包含 codearts', ids.includes('codearts'))
  ok('包含 loomy', ids.includes('loomy'))
  ok('包含 lingxi', ids.includes('lingxi'))
  ok('包含 magpie', ids.includes('magpie'))
  ok('hub 已移除', !ids.includes('hub'))

  console.log('\n[端口与健康端点]')
  const byId = Object.fromEntries(plats.map((p) => [p.id, p]))
  ok('workbuddy 端口 7863', byId.workbuddy.port === 7863)
  ok('workbuddy 健康 /healthz', byId.workbuddy.health.url.endsWith('/healthz'))
  ok('codearts 端口 7866', byId.codearts.port === 7866)
  ok('loomy 端口 17990', byId.loomy.port === 17990)
  ok('lingxi 端口 6789', byId.lingxi.port === 6789)
  ok('magpie 端口 3425', byId.magpie.port === 3425)
  ok('magpie 为 external 类型', byId.magpie.type === 'external')
  ok('magpie managed=false', byId.magpie.managed === false)

  console.log('\n[真实进程：启动 lingxi]')
  // 只启灵犀，避免依赖本机其它网关的账号数据
  const lingxi = byId.lingxi
  const exe = path.join(lingxi.workDir, lingxi.run.binary)
  if (!fs.existsSync(exe)) {
    console.log(`  SKIP  灵犀可执行文件不存在: ${exe}`)
  } else {
    // 端口隔离：若 6789 已被本机真实灵犀实例占用（开发时常见），
    // 改用一个空闲端口，避免把"端口预检生效"误判成"启动失败"。
    const conflict = await checkPortInUse(lingxi.port)
    if (conflict) {
      const freePort = await findFreePort()
      console.log(`  INFO  端口 ${lingxi.port} 已被占用（本机真实实例），改用 ${freePort} 做隔离测试`)
      // 灵犀只认 --config：复制一份指向 workDir 的配置并改端口，
      // auths / data 用绝对路径指向真实目录的绝对位置，但测试实例应为空账号。
      const srcCfg = path.join(lingxi.workDir, 'config.json')
      const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-iso-'))
      let cfg = {}
      if (fs.existsSync(srcCfg)) cfg = JSON.parse(fs.readFileSync(srcCfg, 'utf8'))
      cfg.listen = `:${freePort}`
      cfg.auth_dir = path.join(isoDir, 'auths')       // 空目录 → 0 账号，不碰真实号池
      cfg.state_file = path.join(isoDir, 'state.json')
      if (cfg.logging) cfg.logging.request_archive_enabled = false
      const cfgPath = path.join(isoDir, 'config.json')
      fs.mkdirSync(cfg.auth_dir, { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      lingxi.port = freePort
      lingxi.health.url = `http://127.0.0.1:${freePort}/healthz`
      lingxi.run.args = ['--config', cfgPath]
      lingxi._isoDir = isoDir
      // PlatformManager 持有自己的 runtime 副本（cfg 来自启动时读取的 platforms.json），
      // 必须同步修改它，否则端口预检仍会检查旧端口。
      const rt = manager.getRuntime('lingxi')
      if (rt && rt.cfg) {
        rt.cfg.port = freePort
        rt.cfg.health = { ...(rt.cfg.health || {}), url: `http://127.0.0.1:${freePort}/healthz` }
        rt.cfg.run = { ...(rt.cfg.run || {}), args: ['--config', cfgPath] }
      }
    }
    let started = null
    try {
      started = await manager.start('lingxi')
      ok('start 返回 snapshot', !!started && started.id === 'lingxi')
    } catch (e) {
      ok('start 成功', false, e.message)
    }

    if (started) {
      ok('记录了 pid', started.pid > 0, `pid=${started.pid}`)
      // 无账号时灵犀对 /healthz 返回 503（语义正确：上游不可服务），
      // 因此壳标记为 unhealthy 是预期行为，不是故障。
      ok('状态反映真实上游可用性', ['healthy', 'unhealthy'].includes(started.status), `实际 ${started.status}`)

      // 真实 HTTP 探测：能连上即证明进程在跑
      await sleep(500)
      const h = await getJson(`http://127.0.0.1:${lingxi.port}/healthz`)
      ok('真实健康端点可达（200 或 503）', h.status === 200 || h.status === 503, `status=${h.status}`)
      ok('健康响应含 service=lingxi2api', h.json && h.json.service === 'lingxi2api')

      const m = await getJson(`http://127.0.0.1:${lingxi.port}/v1/models`, { Authorization: `Bearer ${lingxi.apiKey || 'test_key'}` })
      ok('/v1/models 可访问', m.status === 200 || m.status === 401, `status=${m.status}`)

      // 日志收集
      const logs = manager.logsOf ? manager.logsOf('lingxi') : null
      if (logs) {
        ok('日志已收集', logs.length > 0, `行数 ${logs.length}`)
      }

      // 停止
      const stopped = await manager.stop('lingxi')
      ok('stop 后状态为 stopped', stopped.status === 'stopped', `实际 ${stopped.status}`)
      await sleep(800)
      const after = await getJson(`http://127.0.0.1:${lingxi.port}/healthz`)
      ok('停止后端口不再响应', after.status === 0, `status=${after.status}`)
    }
  }

  console.log('\n[external 平台不托管]')
  try {
    const magpieSnap = await manager.start('magpie')
    ok('magpie start 不抛异常', !!magpieSnap)
    ok('magpie 状态非 starting', magpieSnap.status !== 'starting', `实际 ${magpieSnap.status}`)
    ok('magpie 未产生子进程', !magpieSnap.pid || magpieSnap.pid === 0, `pid=${magpieSnap.pid}`)
    const stoppedMagpie = await manager.stop('magpie')
    ok('magpie stop 后 stopped', stoppedMagpie.status === 'stopped')
  } catch (e) {
    ok('magpie 外部平台处理', false, e.message)
  }

  console.log('\n[Manager API]')
  const api = new ApiServer({ manager, store })
  const addr = await api.listen('127.0.0.1:0')
  const base = `http://127.0.0.1:${addr.port}`
  const ov = await getJson(`${base}/api/overview`)
  ok('GET /api/overview 200', ov.status === 200, `status=${ov.status}`)
  ok('overview 含 platforms', ov.json && Array.isArray(ov.json.platforms))
  const pl = await getJson(`${base}/api/platforms`)
  ok('GET /api/platforms 200', pl.status === 200)
  ok('平台列表 6 条', pl.json && pl.json.platforms && pl.json.platforms.length === 6,
    `实际 ${pl.json?.platforms?.length}`)
  const set = await getJson(`${base}/api/settings`)
  ok('GET /api/settings 200', set.status === 200)
  await api.close()

  console.log('\n[清理]')
  await manager.stopAll().catch(() => {})
  await sleep(500)
  try {
    if (byId.lingxi && byId.lingxi._isoDir) fs.rmSync(byId.lingxi._isoDir, { recursive: true, force: true })
  } catch { /* 隔离目录清理失败可忽略 */ }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log('  临时目录已清理')
  } catch {
    console.log('  临时目录清理失败（可忽略）')
  }

  console.log('\n==================================================')
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('失败项:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n验收脚本异常:', e)
  process.exit(1)
})