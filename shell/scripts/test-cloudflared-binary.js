'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const {
  CloudflaredBinary, CLOUDFLARED_VERSION, ASSETS, assetFor,
} = require('../src/tunnel/cloudflared-binary');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function main() {
  assert.strictEqual(CLOUDFLARED_VERSION, '2026.10.6');
  assert.strictEqual(assetFor('win32', 'x64').sha256, ASSETS['win32-x64'].sha256);
  assert.throws(() => assetFor('darwin', 'x64'), (e) => e.code === 'UNSUPPORTED_PLATFORM');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-cloudflared-bin-'));
  try {
    let downloads = 0;
    const success = new CloudflaredBinary({
      dataDir: root, platform: 'win32', arch: 'x64',
      download: async (_url, dest, progress) => {
        downloads++;
        fs.writeFileSync(dest, 'verified-binary');
        progress(15, 15);
      },
      hashFile: async () => ASSETS['win32-x64'].sha256,
      spawn: () => ({ status: 0 }),
      proxy: { withAgent: (_purpose, opts) => opts },
    });
    const binary = await success.ensure();
    assert.ok(fs.existsSync(binary));
    assert.strictEqual(downloads, 1);
    assert.strictEqual(success.status().verified, true);
    assert.strictEqual(success.status().received, 15);
    await success.ensure();
    assert.strictEqual(downloads, 1, '已验证缓存不得重复下载');

    const singleRoot = path.join(root, 'single');
    const gate = deferred();
    let concurrentDownloads = 0;
    const single = new CloudflaredBinary({
      dataDir: singleRoot, platform: 'win32', arch: 'x64',
      download: async (_url, dest) => {
        concurrentDownloads++;
        await gate.promise;
        fs.writeFileSync(dest, 'verified-binary');
      },
      hashFile: async () => ASSETS['win32-x64'].sha256,
      spawn: () => ({ status: 0 }),
    });
    const one = single.ensure();
    const two = single.ensure();
    gate.resolve();
    assert.strictEqual(await one, await two);
    assert.strictEqual(concurrentDownloads, 1, '并发 ensure 必须共享下载');

    const mismatchRoot = path.join(root, 'mismatch');
    let probed = false;
    const mismatch = new CloudflaredBinary({
      dataDir: mismatchRoot, platform: 'win32', arch: 'x64',
      download: async (_url, dest) => fs.writeFileSync(dest, 'bad-binary'),
      hashFile: async () => '0'.repeat(64),
      spawn: () => { probed = true; return { status: 0 }; },
    });
    await assert.rejects(() => mismatch.ensure(), (e) => e.code === 'BINARY_HASH_MISMATCH');
    assert.strictEqual(probed, false, '哈希不匹配不得执行');
    assert.strictEqual(fs.existsSync(mismatch.binaryPath), false);
    assert.strictEqual(fs.readdirSync(mismatch.directory).some((name) => name.includes('.download-')), false);

    const retryRoot = path.join(root, 'retry');
    let attempts = 0;
    const retry = new CloudflaredBinary({
      dataDir: retryRoot, platform: 'win32', arch: 'x64',
      download: async (_url, dest) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        fs.writeFileSync(dest, 'verified-binary');
      },
      hashFile: async () => ASSETS['win32-x64'].sha256,
      spawn: () => ({ status: 0 }),
      sleepFn: async () => {},
    });
    await retry.ensure();
    assert.strictEqual(attempts, 3, '网络错误应按策略重试');

    const deniedRoot = path.join(root, 'denied');
    let deniedAttempts = 0;
    const denied = new CloudflaredBinary({
      dataDir: deniedRoot, platform: 'win32', arch: 'x64',
      download: async () => { deniedAttempts++; throw Object.assign(new Error('403'), { code: 'HTTP_403' }); },
    });
    await assert.rejects(() => denied.ensure(), (e) => e.code === 'BINARY_DOWNLOAD_FAILED');
    assert.strictEqual(deniedAttempts, 1, 'HTTP 403 不得无意义重试');

    const streamRoot = path.join(root, 'stream');
    const streamBinary = new CloudflaredBinary({
      dataDir: streamRoot, platform: 'win32', arch: 'x64', proxy: { withAgent: (_purpose, opts) => opts },
    });
    fs.mkdirSync(streamRoot, { recursive: true });
    const destination = path.join(streamRoot, 'partial-download');
    const originalGet = https.get;
    let abortedResponse;
    try {
      https.get = (_url, _options, callback) => {
        const request = new EventEmitter();
        const response = new Readable({ read() {} });
        response.statusCode = 200;
        response.headers = {};
        abortedResponse = response;
        process.nextTick(() => {
          callback(response);
          setImmediate(() => {
            response.push('partial');
            response.emit('aborted');
            response.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
          });
        });
        return request;
      };
      await assert.rejects(() => streamBinary._downloadOnce('https://example.test/asset', destination, () => {}), (e) => e.code === 'ECONNRESET');
      assert.strictEqual(abortedResponse.destroyed, true, '中断响应必须被销毁');

      https.get = (_url, _options, callback) => {
        const request = new EventEmitter();
        const response = new Readable({ read() {} });
        response.statusCode = 200;
        response.headers = {};
        process.nextTick(() => {
          callback(response);
          setImmediate(() => {
            response.push('complete');
            response.push(null);
          });
        });
        return request;
      };
      fs.rmSync(destination, { force: true });
      await streamBinary._downloadOnce('https://example.test/asset', destination, () => {});
      assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'complete', '清理后同路径可重新下载，不得遗留 wx 句柄');
    } finally {
      https.get = originalGet;
    }

    console.log('PASS cloudflared 下载：固定资产、缓存校验、singleflight、重试、哈希拒绝与断流清理');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
