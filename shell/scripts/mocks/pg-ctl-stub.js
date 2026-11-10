'use strict';
// pg-ctl-stub.js — 伪装 pg_ctl：
//   start -D <dir> ... → spawn 持久桩进程（充当 postgres），写 <dir>/postgres.pid
//   stop  -D <dir> ... → 读 pid 文件，taskkill 该进程树
//   其余（-o/-c 只读查询等）→ 退出 0
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const mode = args[0];
const di = args.indexOf('-D');
const pgData = di >= 0 ? args[di + 1] : '.';
const pidFile = path.join(pgData, 'postgres.pid');

if (mode === 'start') {
  // 幂等：已在跑则直接成功
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); process.exit(0); } catch (_e) { /* stale */ }
  }
  const child = spawn(process.execPath, ['-e',
    'const http=require("http");http.createServer((q,s)=>{s.end("pg ok")}).listen(15433,"127.0.0.1",()=>console.log("pg ready"));setInterval(()=>{},1e9);'],
    { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  process.stdout.write('pg_ctl stub: server starting\n');
  process.exit(0);
}

if (mode === 'stop') {
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (_e) { /* already gone */ }
    fs.unlinkSync(pidFile);
  }
  process.stdout.write('pg_ctl stub: server stopped\n');
  process.exit(0);
}

// status / 其他
process.exit(fs.existsSync(pidFile) ? 0 : 3);
