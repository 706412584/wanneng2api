'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { TargetAdapters } = require('../src/tunnel/target-adapters');
const { PublicApiGateway, cleanPath } = require('../src/tunnel/public-api-gateway');

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
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-public-gateway-'));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"data":[]}');
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        return setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 10);
      }
      res.writeHead(404).end();
    });
  });
  const upstreamPort = await listen(upstream);
  const workDir = path.join(root, 'workbuddy');
  fs.mkdirSync(workDir, { recursive: true });
  const configPath = path.join(workDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ listen: `127.0.0.1:${upstreamPort}`, api_keys: [{ key: 'secret-a' }] }));
  const platform = { id: 'workbuddy', enabled: true, workDir, port: 7863, run: { env: {} } };
  const adapters = new TargetAdapters({ getPlatform: () => platform, env: {} });
  const gateway = new PublicApiGateway({ targetId: 'workbuddy', adapters, maxBodyBytes: 32 });
  try {
    const preflight = await adapters.preflight('workbuddy');
    assert.strictEqual(preflight.keyVerified, true);
    assert.strictEqual(preflight.targetStatus, 200);
    const guardPort = (await gateway.listen()).port;

    let result = await request(guardPort, '/__wanneng_tunnel_health');
    assert.strictEqual(result.status, 200);
    assert.strictEqual(JSON.parse(result.text).ok, true);
    const upstreamBefore = seen.length;
    assert.strictEqual(cleanPath('/v1beta/models/%252e%252e/%252e%252e/admin'), null, '双重编码必须拒绝');
    assert.strictEqual(cleanPath('/v1/models/%2e%2e/admin'), null, '编码点段必须拒绝');
    assert.strictEqual(cleanPath('/v1beta/models/%2e%2e/admin'), null, '残余点段必须拒绝');

    result = await request(guardPort, '/v1/models');
    assert.strictEqual(result.status, 401, '无 Key 必须拒绝');
    result = await request(guardPort, '/v1/models', { headers: { Authorization: 'Bearer wrong' } });
    assert.strictEqual(result.status, 401, '错 Key 必须拒绝');
    result = await request(guardPort, '/__admin/config', { headers: { Authorization: 'Bearer secret-a' } });
    assert.strictEqual(result.status, 404, '管理路径必须拒绝');
    result = await request(guardPort, '/%2e%2e/admin', { headers: { Authorization: 'Bearer secret-a' } });
    assert.strictEqual(result.status, 400, '编码点段必须作为非法路径拒绝');
    assert.strictEqual(seen.length, upstreamBefore, '以上请求不得触达上游');

    result = await request(guardPort, '/v1/models?key=query-secret&region=cn', {
      headers: { 'x-api-key': 'secret-a', 'Cf-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.1' },
    });
    assert.strictEqual(result.status, 200);
    const models = seen.at(-1);
    assert.strictEqual(models.headers.authorization, 'Bearer secret-a');
    assert.strictEqual(models.headers['cf-connecting-ip'], undefined);
    assert.strictEqual(models.headers['x-forwarded-for'], undefined);
    assert.ok(!models.url.includes('query-secret'), 'query Key 不得转发');
    assert.ok(models.url.includes('region=cn'));

    result = await request(guardPort, '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer secret-a', 'Content-Type': 'application/json' }, body: '{"model":"x"}',
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.text, 'data: one\n\ndata: two\n\n');
    assert.strictEqual(result.headers['x-accel-buffering'], 'no');
    assert.ok(result.headers['cache-control'].includes('no-transform'));
    assert.strictEqual(seen.at(-1).headers['accept-encoding'], 'identity');
    assert.strictEqual(seen.at(-1).body, '{"model":"x"}');

    result = await request(guardPort, '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer secret-a' }, body: 'x'.repeat(40),
    });
    assert.strictEqual(result.status, 413, '请求体超限必须拒绝');

    fs.writeFileSync(configPath, JSON.stringify({ listen: `127.0.0.1:${upstreamPort}`, api_keys: [{ key: 'secret-b' }] }));
    result = await request(guardPort, '/v1/models', { headers: { Authorization: 'Bearer secret-a' } });
    assert.strictEqual(result.status, 401, '旧 Key 轮换后必须立即失效');
    result = await request(guardPort, '/v1/models', { headers: { Authorization: 'Bearer secret-b' } });
    assert.strictEqual(result.status, 200, '新 Key 应生效');

    const codearts = new TargetAdapters({
      getPlatform: () => ({ id: 'codearts', workDir, run: { env: {} } }), env: {},
    });
    assert.strictEqual(codearts.routeAllowed('codearts', 'POST', '/v1/responses'), false);
    assert.strictEqual(codearts.routeAllowed('lingxi', 'POST', '/v1/messages'), false);
    assert.strictEqual(codearts.routeAllowed('lingxi', 'POST', '/v1/search/messages'), true);

    fs.writeFileSync(configPath, JSON.stringify({ listen: `127.0.0.1:${upstreamPort}`, admin_key: 'admin-only', api_key: '' }));
    const noKey = new TargetAdapters({
      getPlatform: () => ({ id: 'codearts', enabled: true, workDir, run: { env: {} } }), env: {},
    });
    await assert.rejects(() => noKey.preflight('codearts'), (e) => e.code === 'API_KEY_REQUIRED');

    const magpieDir = path.join(root, 'magpie');
    fs.mkdirSync(magpieDir, { recursive: true });
    fs.writeFileSync(path.join(magpieDir, 'caller-keys.json'), JSON.stringify([
      { secret: 'active', off: false }, { secret: 'disabled', off: true },
      { secret: 'expired', expires: '2000-01-01T00:00:00Z' },
    ]));
    fs.writeFileSync(path.join(magpieDir, 'settings.json'), JSON.stringify({ lan: true, lanKey: 'legacy' }));
    const magpie = new TargetAdapters({ getPlatform: () => ({ id: 'magpie', port: 3425, run: { env: {} } }), env: {}, magpieDir });
    assert.deepStrictEqual(magpie.validKeys('magpie').sort(), ['active', 'legacy']);
    assert.strictEqual(magpie.authorize('magpie', { 'x-api-key': 'active' }), 'active');
    fs.writeFileSync(path.join(magpieDir, 'settings.json'), JSON.stringify({ lan: false, lanKey: 'legacy' }));
    assert.deepStrictEqual(magpie.validKeys('magpie'), ['active']);

    console.log('PASS API 网关：逐请求 Key、路由白名单、Key 轮换、SSE、转发头清理与 magpie Key');
  } finally {
    await gateway.close();
    await close(upstream);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
