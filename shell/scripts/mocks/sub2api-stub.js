'use strict';
// sub2api-stub.js — 伪装 sub2api server.exe：
// 校验注入的 DATABASE_URL/REDIS_HOST/REDIS_PORT → 写 envdump → /health 返回 200
const http = require('http');
const fs = require('fs');
const path = require('path');

const dump = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  REDIS_HOST: process.env.REDIS_HOST || '',
  REDIS_PORT: process.env.REDIS_PORT || '',
  NO_PROXY: process.env.NO_PROXY || '',
  ts: Date.now(),
};
fs.writeFileSync(path.join(__dirname, 'sub2api-envdump.json'), JSON.stringify(dump, null, 2));

const port = Number(process.env.SUB2API_PORT || 17897);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1', () => {
  console.log(`sub2api-stub listening on ${port}`);
});
setInterval(() => {}, 1e9);
