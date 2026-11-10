'use strict';
// mock-healthy.js — 起一个 http 服务模拟健康平台：/healthz 返回 200
const http = require('http');
const port = Number(process.env.MOCK_PORT || 7891);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mock-healthy listening on ${port}`);
});
process.on('SIGTERM', () => process.exit(0));
