'use strict';
// redis-stub.js — 伪装 redis-server：--port N，PING → +PONG
const net = require('net');
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 6380;
const srv = net.createServer((sock) => {
  sock.on('data', (d) => {
    if (d.toString().includes('PING')) sock.write('+PONG\r\n');
  });
});
srv.listen(port, '127.0.0.1', () => {
  // 保持运行；父进程 stop 时 kill
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1e9);
