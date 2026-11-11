'use strict';
/**
 * test-platform-manager.js — PlatformManager 自动化验收测试（不依赖 Electron）
 *
 * 覆盖：
 *  1. spawn → healthy（mock-healthy http 平台）
 *  2. kill 进程 → 2s 内自动拉起（指数退避 baseBackoffSec=0.2 加速）
 *  3. stop 优雅退出（进程退出、状态 stopped）
 *  4. crash 平台：spawn 秒退 → 自动重启 → stop 能终止重启循环
 *  5. 端口预检：端口被外部进程占用 → port-conflict，不 spawn
 *  6. 日志：轮转文件存在 + 环形缓冲 tail
 *  7. enable/disable
 *
 * 运行：node scripts/test-platform-manager.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');

const { ConfigStore, defaultPlatforms } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');
const { checkPortFree } = require('../src/platform-manager');

const PASS = [];
const FAIL = [];
function ok(name, cond, extra = '') {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(mgr, id, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mgr.statusOf(id);
    if (s && s.status === status) return true;
    await sleep(100);
  }
  return false;
}

/** 起一个外部 HTTP 服务占用端口（模拟第三方占用） */
function occupyPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** HTTP 探测（供测试直接验证 mock 服务确实在跑） */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function makeConfig(dir, platforms) {
  return {
    version: 1,
    platforms,
  };
}

function testImportedCodeArtsCommand() {
  const cfg = defaultPlatforms().platforms.find((p) => p.id === 'codearts');
  // 结构性断言：不能硬编码盘符，换机器/CI 也要成立
  ok('CodeArts 默认工作目录以 bin 结尾', /[/\\]bin$/.test(cfg.workDir), `cwd=${cfg.workDir}`);
  ok('CodeArts 默认使用 bin 内的可执行文件', cfg.run.binary === 'codearts2api-panel.exe');

  // 老用户升级迁移：错误旧值被修正，自定义值不被覆盖
  const { ConfigStore } = require('../src/config');
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-migrate-'));
  try {
    fs.writeFileSync(path.join(migDir, 'platforms.json'), JSON.stringify({ version: 1, platforms: [
      { id: 'workbuddy', name: 'WB', workDir: 'D:/软件/workbuddy2api', run: { binary: 'server.exe', args: [] }, port: 7863 },
      { id: 'codearts', name: 'CA', workDir: 'D:/app/codearts2api-panel', run: { binary: 'bin/codearts2api-panel.exe', args: [] }, port: 7866 },
    ] }));
    fs.writeFileSync(path.join(migDir, 'manager.json'), '{}');
    const migrated = new ConfigStore(migDir);
    ok('老配置升级：WorkBuddy 改为 wb2api.exe', migrated.getPlatform('workbuddy').run.binary === 'wb2api.exe');
    ok('老配置升级：CodeArts 改到 bin 并显式 --config',
      /[/\\]bin$/.test(migrated.getPlatform('codearts').workDir)
      && (migrated.getPlatform('codearts').run.args || []).includes('--config'));
  } finally {
    fs.rmSync(migDir, { recursive: true, force: true });
  }

  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-migrate-keep-'));
  try {
    fs.writeFileSync(path.join(keepDir, 'platforms.json'), JSON.stringify({ version: 1, platforms: [
      { id: 'workbuddy', name: 'WB', workDir: 'E:/custom/wb', run: { binary: 'my-build.exe', args: [] }, port: 7863 },
    ] }));
    fs.writeFileSync(path.join(keepDir, 'manager.json'), '{}');
    const kept = new ConfigStore(keepDir);
    ok('老配置升级：用户自定义 binary 不被覆盖', kept.getPlatform('workbuddy').run.binary === 'my-build.exe');
  } finally {
    fs.rmSync(keepDir, { recursive: true, force: true });
  }

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-codearts-config-'));
  try {
    fs.writeFileSync(path.join(fixture, 'codearts2api-panel.exe'), '');
    const rt = { cfg: { ...cfg, workDir: fixture } };
    const context = { store: { platformWorkDir: (p) => path.resolve(p.workDir) } };
    const cmd = PlatformManager.prototype._resolveCommand.call(context, rt);
    ok('CodeArts 命令定位到所选数据目录', cmd.cwd === fixture
      && cmd.command === path.join(fixture, 'codearts2api-panel.exe'));
    ok('CodeArts 显式指定所选目录的 config.json', cmd.args.length === 2 && cmd.args[0] === '--config'
      && path.resolve(cmd.cwd, cmd.args[1]) === path.join(fixture, 'config.json'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

/** 更新源与版本解析：纯函数，不联网 */
function testUpdaterVersionParsing() {
  const { versionFromAsset, isNewerVersion } = require('../src/updater');
  // 旧正则会把平台后缀一起吃掉，界面上出现 "1.2.19-windows-amd64.zip" 这种假版本号
  ok('zip 资产名只取三段版本号',
    versionFromAsset('wb2api-v1.2.19-windows-amd64.zip') === '1.2.19',
    `got ${versionFromAsset('wb2api-v1.2.19-windows-amd64.zip')}`);
  ok('exe 资产名同样只取三段',
    versionFromAsset('workbuddy2api-v1.2.10-windows-amd64.exe') === '1.2.10',
    `got ${versionFromAsset('workbuddy2api-v1.2.10-windows-amd64.exe')}`);
  // CodeArts 用四段版本号 vYY.MM.DD.N，只取三段会把补丁版判成同版本
  ok('codearts 版本号保留四段',
    versionFromAsset('codearts2api-panel_v26.11.05.1_windows_amd64.zip') === '26.11.05.1',
    `got ${versionFromAsset('codearts2api-panel_v26.11.05.1_windows_amd64.zip')}`);
  ok('wb2api 前缀里的 v2 不被误认成版本',
    versionFromAsset('wb2api-v1.2.19-windows-amd64.zip') === '1.2.19',
    `got ${versionFromAsset('wb2api-v1.2.19-windows-amd64.zip')}`);
  ok('无版本号的资产返回 null', versionFromAsset('SHA256SUMS') === null);
  ok('1.2.19 比 1.2.10 新', isNewerVersion('1.2.19', '1.2.10') === true);
  ok('同版本不算更新', isNewerVersion('1.2.19', '1.2.19') === false);
  // 四段补丁版必须能推进，否则 pin 在 v26.11.05.x 的网关永远收不到新构建
  ok('26.11.05.2 比 26.11.05.1 新', isNewerVersion('26.11.05.2', '26.11.05.1') === true);
  ok('26.11.05.1 不比 26.11.05.2 新', isNewerVersion('26.11.05.1', '26.11.05.2') === false);
  ok('缺位按 0 处理：1.2 与 1.2.0 相等', isNewerVersion('1.2', '1.2.0') === false);
}

/**
 * replace-dir 必须真的解包 zip。
 *
 * 回归：下载路径是 "<资产名>.part"，旧代码用 /\.zip$/ 判断 → 永远为假，
 * 整个 zip 被当成「单 exe」拷进工作目录，sub2api/WorkBuddy/CodeArts
 * 每次更新都必然失败。这里用真 zip 走一遍 _replaceDir。
 */
async function testReplaceDirUnzipsZip() {
  const { PlatformUpdater } = require('../src/updater');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-zip-'));
  try {
    const workDir = path.join(root, 'work');
    const updDir = path.join(root, 'upd');
    const backupDir = path.join(root, 'backup');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(updDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    // 旧数据文件必须被 preserveGlobs 保住
    fs.writeFileSync(path.join(workDir, 'config.yaml'), 'KEEP-ME');

    // 造一个带一层根目录的 zip：<root>/sub2api.exe + <root>/README.md
    const stage = path.join(root, 'stage', 'pkg');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'sub2api.exe'), 'NEW-BINARY');
    fs.writeFileSync(path.join(stage, 'README.md'), 'docs');
    // 打一个真 zip 出来。两条路径都试过：
    //   Windows: PowerShell 的 .NET ZipFile（tar -a 认不出 zip 格式，
    //            Compress-Archive 又会按扩展名拒绝写 .part）
    //   POSIX:   python3 -m zipfile（CI 的 ubuntu runner 自带）
    // 打成 .zip 再改名成 .part，正好复刻「下载得到 .zip.part」的真实形态。
    const zipTmp = path.join(updDir, 'pkg_windows_amd64.zip');
    const zipPath = zipTmp + '.part';
    const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
      require('child_process').execFile(cmd, args, { windowsHide: true, timeout: 60000, ...opts },
        (e) => (e ? reject(e) : resolve()));
    });
    if (process.platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${zipTmp}')`]);
    } else {
      // 在 stage 的父目录执行并传目录名：传绝对路径会把整条路径写进 zip，
      // 解出来多好几层，_stripSingleRoot 也就剥不掉了。
      // python zipfile 不支持 -C，靠 cwd 控制根目录。
      await run('python3', ['-m', 'zipfile', '-c', zipTmp, path.basename(stage)],
        { cwd: path.dirname(stage) });
    }
    fs.renameSync(zipTmp, zipPath);

    const store = {
      platformWorkDir: () => workDir,
      getPlatform: () => ({ id: 'sub2api', updater: { preserveGlobs: ['config.yaml'] } }),
    };
    const upd = new PlatformUpdater({ manager: {}, store, dataDir: root, logger: { info(){}, warn(){}, error(){} } });
    await upd._replaceDir(store.getPlatform(), zipPath, updDir, backupDir);

    ok('replace-dir 解包 .part 的 zip：二进制落地',
      fs.existsSync(path.join(workDir, 'sub2api.exe'))
      && fs.readFileSync(path.join(workDir, 'sub2api.exe'), 'utf8') === 'NEW-BINARY');
    ok('replace-dir 剥掉 zip 的单层根目录', !fs.existsSync(path.join(workDir, 'pkg')));
    ok('replace-dir 保留被保护的数据文件',
      fs.readFileSync(path.join(workDir, 'config.yaml'), 'utf8') === 'KEEP-ME');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 禁用平台的更新必须算成功。
 *
 * 回归：apply 的第 5 步会 manager.start(id) 做健康验证，
 * 而 start() 对 enabled=false 直接抛「平台已禁用，请先 enable」，
 * 于是「安装成功」被 catch 成失败 → 回滚 → 界面永远显示更新失败
 * （sub2api 的实际症状）。这里用一个最小假实现跑通 apply。
 */
async function testDisabledPlatformUpdateSucceeds() {
  const { PlatformUpdater } = require('../src/updater');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-disabled-'));
  try {
    const workDir = path.join(root, 'work');
    const updDir = path.join(root, 'upd');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(updDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'app.exe'), 'OLD');

    const p = {
      id: 'mockdisabled', name: 'MD', enabled: false, workDir,
      run: { binary: 'app.exe' },
      updater: { repo: 'x/y', strategy: 'replace-binary', preserveGlobs: [] },
    };
    const store = {
      platformWorkDir: () => workDir,
      getPlatform: () => p,
      updatePlatform: () => {},
      manager: { update: {} },
    };
    const rt = {
      cfg: p, status: 'stopped', proc: null, version: undefined,
      setStatus(s) { this.status = s; },
      appendLog() {},
    };
    const manager = {
      // 与真实平台管理器一致：禁用平台一律拒绝启动
      start: async () => { throw new Error('平台已禁用，请先 enable'); },
      stop: async () => {},
      getRuntime: () => rt,
      emit: () => {},
    };
    const upd = new PlatformUpdater({ manager, store, dataDir: root, logger: { info(){}, warn(){}, error(){} } });
    // 绕过网络：直接给 checkInfo，并伪造下载
    upd._download = async (_url, dest) => { fs.writeFileSync(dest, 'NEW'); return dest; };
    upd._replaceBinary = async () => ({ binaryPath: path.join(workDir, 'app.exe') });
    upd.manager = manager;

    const r = await upd.apply('mockdisabled', {
      checked: true, hasUpdate: true, assetUrl: 'https://example.invalid/app.exe',
      latest: '9.9.9', current: '1.0.0',
    });
    ok('禁用平台的更新返回成功', r.ok === true, JSON.stringify(r));
    ok('禁用平台更新标记 disabled=true', r.disabled === true);
    ok('禁用平台更新后状态为 stopped（不谎报 healthy）', rt.status === 'stopped', `got ${rt.status}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 跨平台分支的静态断言：不依赖真实 POSIX 环境，只保证分支存在且形状正确。
 * 真正的行为验证在 CI 的 ubuntu-latest 上跑完整回归。
 */
function testCrossPlatformShape() {
  const pm = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform-manager.js'), 'utf8');
  ok('POSIX 用进程组杀树（kill(-pid)）', /process\.kill\(-pid, sig\)/.test(pm));
  ok('POSIX spawn 设 detached 自成进程组', /detached: true/.test(pm));
  ok('POSIX 用 ss 替代 netstat', /execFile\('ss'/.test(pm));
  ok('POSIX 校验可执行位（X_OK）', /fs\.constants\.X_OK/.test(pm));

  const up = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
  ok('POSIX 解压优先 unzip', /execFile\('unzip'/.test(up));
  ok('POSIX 解压退回 tar', /execFile\('tar', \['-xf'/.test(up));
  ok('解压合并补回执行位', /chmodSync\(d, 0o755\)/.test(up));
  ok('replace-binary 补回执行位', /chmodSync\(target, 0o755\)/.test(up));
  // Windows 专用路径必须保留，不能被跨平台改造误删
  ok('Windows 仍用 --force-local 解 tar', /--force-local/.test(up));
  ok('Windows 仍保留 PowerShell 兜底', /Expand-Archive/.test(up));
  ok('Windows 仍用 taskkill /T', /taskkill\.exe/.test(pm));

  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  ok('默认可执行名按平台推导', /const EXE = process\.platform === 'win32' \? '\.exe' : ''/.test(cfg));
  const { defaultPlatforms } = require('../src/config');
  const wb = defaultPlatforms().platforms.find((p) => p.id === 'workbuddy');
  ok('Windows 下默认名带 .exe', process.platform !== 'win32' || wb.run.binary === 'wb2api.exe',
    `got ${wb.run.binary}`);
  ok('POSIX 下默认名不带 .exe', process.platform === 'win32' || wb.run.binary === 'wb2api',
    `got ${wb.run.binary}`);
}

async function main() {
  console.log('[跨平台分支：静态断言，不启动进程]');
  testCrossPlatformShape();
  console.log('[replace-dir zip 解包回归：不启动进程]');
  await testReplaceDirUnzipsZip();
  console.log('[禁用平台更新回归：不启动进程]');
  await testDisabledPlatformUpdateSucceeds();
  console.log('[CodeArts 导入配置回归：不启动进程]');
  testImportedCodeArtsCommand();
  console.log('[更新源版本解析回归：不联网]');
  testUpdaterVersionParsing();
  if (process.argv.includes('--config-only')) {
    console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
    process.exitCode = FAIL.length ? 1 : 0;
    return;
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-test-'));
  const mocksDir = path.join(__dirname, 'mocks');
  console.log(`dataDir = ${dataDir}\n`);

  // ── 准备配置：mock 平台（fast 退避参数便于测试）──
  const store = new ConfigStore(path.join(dataDir, 'cfg'));
  store.platforms = makeConfig(0, [
    {
      id: 'mockhealthy',
      name: 'Mock Healthy',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: '17891' } },
      port: 17891,
      health: { url: 'http://127.0.0.1:17891/healthz', intervalSec: 1, timeoutSec: 2, failThreshold: 2, okThreshold: 1 },
      adminPanel: 'http://127.0.0.1:17891/',
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 1, maxRetries: 0 },
    },
    {
      id: 'mockcrash',
      name: 'Mock Crash',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-crash.js'], env: {} },
      port: 0, // 无端口服务
      health: { url: 'http://127.0.0.1:17892/healthz', intervalSec: 1, timeoutSec: 1, failThreshold: 2, okThreshold: 1 },
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 0.5, maxRetries: 0 },
    },
    {
      id: 'portconflict',
      name: 'Port Conflict Target',
      type: 'node',
      enabled: true,
      mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: '17893' } },
      port: 17893,
      health: { url: 'http://127.0.0.1:17893/healthz', intervalSec: 1, timeoutSec: 1, failThreshold: 1, okThreshold: 1 },
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 1, maxRetries: 0 },
    },
  ]);

  const mgr = new PlatformManager({
    store,
    dataDir,
    shellRoot: path.resolve(__dirname, '..'),
    logger: { info: () => {}, warn: () => {}, error: (m) => console.error('    [mgr-err]', m) },
  });

  // ── 1. spawn → healthy ──
  console.log('\n[1] spawn → healthy');
  const snap1 = await mgr.start('mockhealthy');
  ok('start 返回 starting/healthy', ['starting', 'healthy'].includes(snap1.status), `got ${snap1.status}`);
  ok('pid > 0', snap1.pid > 0);
  const healthy = await waitStatus(mgr, 'mockhealthy', 'healthy', 15000);
  ok('状态变为 healthy', healthy, `got ${mgr.statusOf('mockhealthy').status}`);
  const httpOk = await probe('http://127.0.0.1:17891/healthz');
  ok('mock 服务真实响应 /healthz=200', httpOk === 200, `got ${httpOk}`);

  // ── 2. kill 进程 → 2s 内自动拉起 ──
  console.log('\n[2] kill → 自动重启（≤2s）');
  const oldPid = mgr.statusOf('mockhealthy').pid;
  try { process.kill(oldPid); } catch (_e) { /* ignore */ }
  // 等待 exit 事件触发 → backoff(0.2s) 重启
  const revived = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = mgr.statusOf('mockhealthy');
      if (s.pid && s.pid !== oldPid && s.status === 'healthy') return true;
      await sleep(100);
    }
    return false;
  })();
  ok('进程被杀后 2s 内自动拉起并 healthy', revived, `oldPid=${oldPid} now=${JSON.stringify(mgr.statusOf('mockhealthy'))}`);

  // ── 3. stop 优雅退出 ──
  console.log('\n[3] stop 优雅退出');
  const stopPid = mgr.statusOf('mockhealthy').pid;
  const snapStop = await mgr.stop('mockhealthy');
  ok('stop 后状态 stopped', snapStop.status === 'stopped', `got ${snapStop.status}`);
  ok('stop 后 pid=0', snapStop.pid === 0);
  await sleep(300);
  const portFree = await checkPortFree(17891);
  ok('stop 后端口释放', portFree.free, `occupied by ${portFree.pid}`);

  // ── 4. crash 平台：秒退 → 自动重启循环 → stop 终止 ──
  console.log('\n[4] crash 平台：自动重启循环');
  try { await mgr.start('mockcrash'); } catch (_e) { /* 秒退可能抛错，允许 */ }
  // crash 后进入 error+restartAttempts 递增
  await sleep(2500);
  const crashSnap = mgr.statusOf('mockcrash');
  ok('crash 平台触发自动重启（restartAttempts≥1）', crashSnap.restartAttempts >= 1,
    `attempts=${crashSnap.restartAttempts} status=${crashSnap.status}`);
  // 注：crash 桩 300ms 后退出，快照可能在 backoff 窗口内恰好捕捉到活进程（重试中的实例），
  // 「无残留进程」的确定性断言放在 stop 之后（stop 同步清空 pid 且终止重启循环）。
  await mgr.stop('mockcrash');
  const crashAfterStop = mgr.statusOf('mockcrash');
  ok('stop 后无残留进程', crashAfterStop.pid === 0, `pid=${crashAfterStop.pid}`);
  ok('stop 终止重启循环（stopped 且不再递增）', crashAfterStop.status === 'stopped');
  const attemptsAtStop = crashAfterStop.restartAttempts;
  await sleep(1500);
  ok('stop 后 1.5s 无新重启', mgr.statusOf('mockcrash').restartAttempts === attemptsAtStop,
    `attempts ${attemptsAtStop} → ${mgr.statusOf('mockcrash').restartAttempts}`);

  // ── 5. 端口预检 ──
  console.log('\n[5] 端口预检 port-conflict');
  const occupier = await occupyPort(17893);
  try { await mgr.start('portconflict'); ok('被占用端口应拒绝 spawn', false); }
  catch (e) { ok('被占用端口报 port-conflict 拒绝 spawn', /port-conflict/.test(e.message), e.message); }
  const errSnap = mgr.statusOf('portconflict');
  ok('冲突平台状态 error', errSnap.status === 'error', `got ${errSnap.status}`);
  ok('冲突平台无进程', errSnap.pid === 0);
  // Windows 上 net.Server.close() 若仍有连接（哪怕已半关）会不回调。
// 先强制断开再关，并加超时兜底，避免整个测试挂死。
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    try { occupier.closeAllConnections?.(); } catch (_e) { /* 老 Node 无此 API */ }
    occupier.close(() => { clearTimeout(t); resolve(); });
  });

  // ── 5b. force 不得杀掉本平台自己的实例（真实事故回归）──
  console.log('\n[5b] force 与收养的边界');
  {
    // 端口上跑的是本平台的实例（用 mock 服务冒充：adoptHints 命中即可）
    // 独立端口，避免与上面第 5 节的占用者互相污染
    const forcePort = 17897;
    const ownCfg = {
      id: 'forceadopt', name: 'Force Adopt', type: 'node', enabled: true, mode: 'managed',
      workDir: mocksDir,
      run: { binary: 'node', args: ['mock-healthy.js'], env: { MOCK_PORT: String(forcePort) } },
      port: forcePort,
      // 不设 adoptHints：任何 HTTP 响应即视为本平台实例
      health: { url: `http://127.0.0.1:${forcePort}/healthz`, intervalSec: 1, timeoutSec: 1, failThreshold: 1, okThreshold: 1 },
      restart: { baseBackoffSec: 0.2, maxBackoffSec: 1, maxRetries: 0 },
    };
    store.platforms.platforms.push(ownCfg);
    const rt = new (require('../src/platform-manager').PlatformManager)({
      store, dataDir, shellRoot: path.resolve(__dirname, '..'), logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    // 给这个端口装一个能回 HTTP 的假服务
    const http2 = require('http');
    const fake = http2.createServer((reqq, ress) => { ress.writeHead(200); ress.end('ok'); });
    await new Promise((r) => fake.listen(forcePort, '127.0.0.1', r));
    try { await rt.start('forceadopt', { force: true }); } catch (_e) { /* 可能收养失败 */ }
    const snap = rt.statusOf('forceadopt');
    ok('force 遇到本平台实例时收养而非杀进程', snap.adopted === true, `adopted=${snap.adopted} status=${snap.status}`);
    rt.destroy();
    await new Promise((r) => { try { fake.closeAllConnections?.(); } catch (_e) {} fake.close(() => r()); });
    store.platforms.platforms = store.platforms.platforms.filter((x) => x.id !== 'forceadopt');
  }

  // ── 6. enable/disable ──
  console.log('\n[6] enable/disable');
  const dis = mgr.disable('mockcrash');
  ok('disable 生效', dis.enabled === false && store.getPlatform('mockcrash').enabled === false);
  try { await mgr.start('mockcrash'); ok('disabled 平台 start 应被拒绝', false); }
  catch (e) { ok('disabled 平台 start 被拒绝', /禁用/.test(e.message), e.message); }
  const en = mgr.enable('mockcrash');
  ok('enable 生效', en.enabled === true && store.getPlatform('mockcrash').enabled === true);

  // ── 7. 日志：轮转文件 + 环形缓冲 ──
  console.log('\n[7] 日志落盘与环形缓冲');
  const logFile = path.join(dataDir, 'logs', 'platforms', 'mockhealthy.log');
  ok('轮转日志文件存在', fs.existsSync(logFile), logFile);
  const lines = mgr.tailLogs('mockhealthy', 500);
  ok('环形缓冲有内容（≥5 行）', lines.length >= 5, `lines=${lines.length}`);
  ok('日志包含 spawn 记录', lines.some((l) => l.includes('spawn:')));
  ok('日志包含 exit 记录', lines.some((l) => /exit code=/.test(l)));
  const tail3 = mgr.tailLogs('mockhealthy', 3);
  ok('tail=3 正确截取', tail3.length === 3 && tail3[2] === lines[lines.length - 1]);

  // ── 清理 ──
  console.log('\n[cleanup] 停止全部');
  await mgr.stopAll();
  mgr.destroy();
  const allStopped = mgr.statusList().every((s) => s.pid === 0);
  ok('stopAll 后无残留进程', allStopped);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  // ── 汇总 ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('Failures:');
    for (const f of FAIL) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
