'use strict';
// pg-isready-stub.js — 伪装 pg_isready：pgdata 有 postgres.pid（说明 server 在跑）则就绪
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
// 真实 pg_isready 不接收 -D；桩从环境变量或相对路径找 pgdata。约定：cwd 为 shell 运行目录，
// 由 platform-manager 传参 ['-h','127.0.0.1','-p',port]。这里改从 PGDATA_STUB 环境变量读取。
void args;
const pgData = process.env.PGDATA_STUB || '';
const pidFile = path.join(pgData, 'postgres.pid');
if (pgData && fs.existsSync(pidFile)) {
  process.stdout.write('127.0.0.1:5433 - accepting connections\n');
  process.exit(0);
}
process.stderr.write('no response\n');
process.exit(2);
