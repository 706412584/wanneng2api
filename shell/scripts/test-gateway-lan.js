'use strict';
/**
 * test-gateway-lan.js — 网关「局域网访问」开关的离线回归
 *
 * 只操作临时目录里的配置副本，绝不触碰真实网关配置。
 * 运行：node scripts/test-gateway-lan.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { GatewayPanel } = require('../src/gateway-panel');

const PASS = [];
const FAIL = [];
function ok(name, cond, extra = '') {
  if (cond) { PASS.push(name); console.log(`  PASS  ${name}`); }
  else { FAIL.push(`${name}${extra ? ' — ' + extra : ''}`); console.log(`  FAIL  ${name} ${extra}`); }
}

/** 造一个临时网关目录，写入初始 config.json。port 缺省时从 listen 推。 */
function makePlatform(root, id, config) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  // _platform() 会校验平台 port 必须是合法端口；config 里没写 port 时
  // 从 listen 尾部推出来（真实 platforms.json 里 port 一定是有值的）。
  const fromListen = Number(String(config.listen || '').split(':').pop());
  const port = config.port || (Number.isFinite(fromListen) ? fromListen : 6789);
  return { id, workDir: dir, port, run: { env: {} } };
}

function readCfg(p) {
  return JSON.parse(fs.readFileSync(path.join(p.workDir, 'config.json'), 'utf8'));
}

async function rejects(fn) {
  try { await fn(); return false; } catch { return true; }
}
async function accepts(fn) {
  try { await fn(); return true; } catch { return false; }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-lan-'));

  const wb = makePlatform(root, 'workbuddy', { listen: ':7863', api_keys: [] });
  const ca = makePlatform(root, 'codearts', { listen: '127.0.0.1:7866', admin_key: 'x' });
  const lx = makePlatform(root, 'lingxi', { listen: '0.0.0.0:6789', api_key: 'x' });
  const lo = makePlatform(root, 'loomy', { host: '127.0.0.1', port: 17990, api_keys: [] });

  const byId = { workbuddy: wb, codearts: ca, lingxi: lx, loomy: lo };
  const gp = new GatewayPanel({ getPlatform: (id) => byId[id] });

  // ── 读取：识别省略 host 的写法 ──
  console.log('\n[读取状态]');
  ok('":7863" 视为局域网开放', gp.lanStatus(wb).enabled === true);
  ok('"127.0.0.1:7866" 视为仅本机', gp.lanStatus(ca).enabled === false);
  ok('"0.0.0.0:6789" 视为局域网开放', gp.lanStatus(lx).enabled === true);
  ok('loomy host=127.0.0.1 视为仅本机', gp.lanStatus(lo).enabled === false);
  ok('loomy 端口从 config 读取', gp.lanStatus(lo).port === 17990, String(gp.lanStatus(lo).port));

  // ── 切换：只改 host，端口不动 ──
  console.log('\n[切换]');
  const r1 = gp.setLan(lo, true);
  ok('loomy 打开 → 成功', r1.enabled === true && r1.host === '0.0.0.0');
  ok('loomy 打开 → 端口不变', r1.port === 17990, String(r1.port));
  ok('loomy 打开 → 写回 config.host', readCfg(lo).host === '0.0.0.0', JSON.stringify(readCfg(lo).host));
  ok('loomy 打开 → 其他字段保留', readCfg(lo).port === 17990 && Array.isArray(readCfg(lo).api_keys));
  ok('loomy 打开 → 生成备份', fs.existsSync(r1.backup), r1.backup);

  const r2 = gp.setLan(ca, true);
  ok('codearts 打开 → listen 变成 0.0.0.0:7866', readCfg(ca).listen === '0.0.0.0:7866', readCfg(ca).listen);
  ok('codearts 打开 → 其他字段保留', readCfg(ca).admin_key === 'x');

  gp.setLan(wb, false);
  ok('workbuddy 关闭 → listen 变成 127.0.0.1:7863', readCfg(wb).listen === '127.0.0.1:7863', readCfg(wb).listen);
  ok('workbuddy 关闭 → 状态变仅本机', gp.lanStatus(wb).enabled === false);

  gp.setLan(lx, false);
  ok('lingxi 关闭 → 状态变仅本机', gp.lanStatus(lx).enabled === false);

  // ── 幂等：重复设置同一值不报错 ──
  console.log('\n[幂等]');
  ok('重复关闭不报错', (() => { try { gp.setLan(lx, false); return true; } catch { return false; } })());
  ok('重复关闭结果不变', readCfg(lx).listen === '127.0.0.1:6789', readCfg(lx).listen);

  // ── 环境变量覆盖：必须拒绝，不能假装成功 ──
  console.log('\n[环境变量覆盖]');
  lo.run.env.LOOMY_HOST = '0.0.0.0';
  const st = gp.lanStatus(lo);
  ok('状态反映环境变量生效值', st.host === '0.0.0.0', st.host);
  ok('状态标出被覆盖', st.overriddenBy === 'LOOMY_HOST');
  ok('被覆盖时切换被拒绝', (() => { try { gp.setLan(lo, false); return false; } catch { return true; } })());

  // ── 异常输入 ──
  // action() 是 async：校验失败是 rejected promise，不是同步 throw。
  // 用 rejects 语义判（下面 main 改成 async 后改走 await）。
  console.log('\n[异常输入]');
  const empty = { id: 'workbuddy', workDir: path.join(root, 'nope'), port: 1, run: { env: {} } };
  ok('缺少 config.json 时读取报错', (() => {
    try { gp.lanStatus(empty); return false; } catch { return true; }
  })());
  ok('enabled 非布尔被拒绝', await rejects(() => gp.action('workbuddy', 'lan-set', { enabled: 'yes' })));
  ok('enabled 缺失被拒绝', await rejects(() => gp.action('workbuddy', 'lan-set', {})));
  ok('未知平台被拒绝', await rejects(() => gp.action('nonexist', 'lan-set', { enabled: true })));
  // 用一个全新的平台实例验证分发层放行（不掺前面用例留下的状态）
  const fresh = makePlatform(root, 'lingxi', { listen: ':6789', api_key: 'x' });
  byId.lingxi = fresh;
  ok('lan-set 能正常走通（非 HTTP 动作）', await accepts(() => gp.action('lingxi', 'lan-set', { enabled: false })));

  // ── IPv6 与纯端口写法 ──
  console.log('\n[地址解析]');
  const v6 = makePlatform(root, 'lingxi', { listen: '[::1]:6789' });
  ok('[::1]:6789 视为仅本机', gp.lanStatus(v6).enabled === false);
  const onlyPort = makePlatform(root, 'codearts', { listen: '7866' });
  ok('纯端口 "7866" 视为局域网开放', gp.lanStatus(onlyPort).enabled === true);
  ok('纯端口解析出正确端口', gp.lanStatus(onlyPort).port === 7866);

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { for (const f of FAIL) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });