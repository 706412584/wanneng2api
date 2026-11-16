'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { TunnelStore } = require('../src/tunnel/tunnel-store');
const { RemoteAuth } = require('../src/tunnel/remote-auth');
const { RemoteGateway } = require('../src/tunnel/remote-gateway');

const PUBLIC = 'https://manager.example.com';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method,
      headers: { Host: 'manager.example.com', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function login(port, password = 'correct-password', ip = '203.0.113.10') {
  return request(port, '/__wanneng_tunnel_login', {
    method: 'POST',
    headers: { Origin: PUBLIC, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username: 'admin', password }),
  });
}

function cookieHeaders(response) {
  const cookies = response.headers['set-cookie'];
  const session = cookies.find((value) => value.startsWith('__Host-wanneng_session=')).split(';')[0];
  const csrf = cookies.find((value) => value.startsWith('__Host-wanneng_csrf=')).split(';')[0];
  return { Cookie: `${session}; ${csrf}`, csrf: csrf.split('=')[1] };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-remote-gateway-'));
  const seen = [];
  const manager = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/api/overview') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://127.0.0.1:17800' });
        return res.end('{"running":1}');
      }
      if (req.url === '/api/action') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString() }));
      }
      if (req.url === '/api/platforms/workbuddy/logs/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        return setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 10);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>local ui</h1>');
    });
  });
  const managerPort = await listen(manager);
  const store = new TunnelStore(root);
  const auth = new RemoteAuth({ store });
  const gateway = new RemoteGateway({ auth, managerOrigin: `http://127.0.0.1:${managerPort}`, publicUrl: PUBLIC });
  try {
    await auth.setPassword(null, 'correct-password');
    assert.strictEqual(auth.passwordConfigured, true);
    assert.ok(!JSON.stringify(store.get('manager')).includes('correct-password'));
    await assert.rejects(() => auth.setPassword('wrong', 'new-password-123'), (e) => e.code === 'PASSWORD_INVALID');

    const port = (await gateway.listen()).port;
    let result = await request(port, '/__wanneng_tunnel_health', { headers: { Host: 'anything' } });
    assert.strictEqual(result.status, 200);
    result = await request(port, '/api/overview', { headers: { Host: 'evil.example' } });
    assert.strictEqual(result.status, 403, 'Host 不匹配必须拒绝');
    result = await request(port, '/api/overview');
    assert.strictEqual(result.status, 401, '未登录 API 必须拒绝');
    result = await request(port, '/');
    assert.strictEqual(result.status, 200);
    assert.ok(result.text.includes('远程管理台需要管理员验证'));
    assert.ok(result.headers['content-security-policy'].includes("default-src 'none'"));

    result = await request(port, '/__wanneng_tunnel_login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-password' }),
    });
    assert.strictEqual(result.status, 403, '无 Origin 登录必须拒绝');
    result = await request(port, '/__wanneng_tunnel_login', {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(result.status, 403, '错 Origin 登录必须拒绝');
    result = await login(port, 'wrong-password', '203.0.113.11');
    assert.strictEqual(result.status, 401);
    result = await login(port);
    assert.strictEqual(result.status, 200);
    const session = cookieHeaders(result);
    const setCookies = result.headers['set-cookie'].join(';');
    assert.ok(setCookies.includes('HttpOnly'));
    assert.ok(setCookies.includes('Secure'));
    assert.ok(setCookies.includes('SameSite=Strict'));
    assert.ok(result.headers['set-cookie'][1].startsWith('__Host-wanneng_csrf='));
    assert.ok(!result.headers['set-cookie'][1].includes('HttpOnly'));

    result = await request(port, '/api/overview', { headers: { Cookie: session.Cookie } });
    assert.strictEqual(result.status, 200);
    const internal = seen.at(-1);
    assert.strictEqual(internal.headers.host, `127.0.0.1:${managerPort}`);
    assert.strictEqual(internal.headers.origin, `http://127.0.0.1:${managerPort}`);
    assert.strictEqual(internal.headers['x-wanneng-client'], 'wanneng2api');
    assert.strictEqual(internal.headers.cookie, undefined, '远程 Cookie 不得进入内部 API');
    assert.strictEqual(result.headers['access-control-allow-origin'], undefined);
    assert.strictEqual(result.headers['x-frame-options'], 'DENY', '认证后的管理台也必须禁止 iframe 嵌套');

    result = await request(port, '/api/action', {
      method: 'POST', headers: { Cookie: session.Cookie, Origin: PUBLIC, 'Content-Type': 'application/json' }, body: '{"x":1}',
    });
    assert.strictEqual(result.status, 403, '无 CSRF 写请求必须拒绝');
    result = await request(port, '/api/action', {
      method: 'POST', headers: { Cookie: session.Cookie, Origin: 'https://evil.example', 'X-Wanneng-CSRF': session.csrf }, body: '{}',
    });
    assert.strictEqual(result.status, 403, '错 Origin 写请求必须拒绝');
    result = await request(port, '/api/action', {
      method: 'POST', headers: { Cookie: session.Cookie, Origin: PUBLIC, 'X-Wanneng-CSRF': session.csrf, 'Content-Type': 'application/json' }, body: '{"x":1}',
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(seen.at(-1).headers['x-wanneng-csrf'], undefined);

    result = await request(port, '/api/platforms/workbuddy/logs/stream', { headers: { Cookie: session.Cookie } });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.text, 'data: one\n\ndata: two\n\n');
    assert.strictEqual(result.headers['x-accel-buffering'], 'no');
    assert.ok(result.headers['cache-control'].includes('no-transform'));
    assert.strictEqual(seen.at(-1).headers['accept-encoding'], 'identity');

    result = await request(port, '/__wanneng_tunnel_session', { headers: { Cookie: session.Cookie } });
    assert.strictEqual(JSON.parse(result.text).authenticated, true);
    result = await request(port, '/__wanneng_tunnel_logout', {
      method: 'POST', headers: { Cookie: session.Cookie, Origin: PUBLIC, 'X-Wanneng-CSRF': session.csrf },
    });
    assert.strictEqual(result.status, 200);
    result = await request(port, '/api/overview', { headers: { Cookie: session.Cookie } });
    assert.strictEqual(result.status, 401, '注销后会话必须失效');

    const second = await login(port, 'correct-password', '203.0.113.12');
    const secondSession = cookieHeaders(second);
    await auth.setPassword('correct-password', 'new-password-123');
    result = await request(port, '/api/overview', { headers: { Cookie: secondSession.Cookie } });
    assert.strictEqual(result.status, 401, '改密码必须撤销全部会话');
    result = await login(port, 'new-password-123', '203.0.113.13');
    assert.strictEqual(result.status, 200);

    const limited = new RemoteAuth({ store });
    await limited.setPassword('new-password-123', 'rate-limit-password');
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => limited.login('admin', 'bad', '198.51.100.1'), (e) => e.code === 'LOGIN_INVALID');
    }
    await assert.rejects(() => limited.login('admin', 'rate-limit-password', '198.51.100.1'), (e) => e.code === 'LOGIN_RATE_LIMITED');

    const concurrent = new RemoteAuth({ store });
    await concurrent.setPassword('rate-limit-password', 'concurrent-password');
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => concurrent.login('admin', 'bad', '198.51.100.99')));
    assert.ok(attempts.some((result) => result.status === 'rejected' && result.reason.code === 'LOGIN_RATE_LIMITED'),
      '并发登录必须受进行中队列上限约束');
    assert.strictEqual(concurrent.inFlight, 0, '登录结束后并发计数必须归零');

    console.log('PASS 远程管理台：scrypt、会话、CSRF、Origin/Host、限流、SSE、注销与改密撤销');
  } finally {
    await gateway.close();
    await close(manager);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
