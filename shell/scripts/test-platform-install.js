'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ConfigStore } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');
const { PlatformUpdater } = require('../src/updater');

async function main() {
  process.env.WANNENG_DISABLE_SYSTEM_MAGPIE = '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-install-test-'));
  const archive = path.join(root, 'gateway.zip');
  const stage = path.join(root, 'package');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'README.md'), 'test package');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFile(path.join(stage, 'README.md'));
  zip.writeZip(archive);
  const payload = fs.readFileSync(archive);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  let assetRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/release') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tag_name: 'v1.0.0', assets: [{ name: 'gateway.zip', browser_download_url: 'http://unused', size: payload.length, digest: `sha256:${digest}` }] }));
      return;
    }
    if (req.url === '/asset') { assetRequests++; res.end(payload); return; }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let manager;
  try {
    const store = new ConfigStore(path.join(root, 'data'));
    const gatewayDefaults = store.platforms.platforms.filter((p) => ['workbuddy', 'codearts', 'loomy', 'lingxi'].includes(p.id));
    assert(gatewayDefaults.every((p) => p.workDir.startsWith(store.dataDir) && p.mode === 'managed'), '新默认不能使用开发机路径');
    assert.strictEqual(store.getPlatform('workbuddy').updater.repo, '706412584/workbuddy2api');
    assert.strictEqual(store.getPlatform('codearts').updater.repo, '706412584/codearts2api-panel');
    assert.strictEqual(store.getPlatform('workbuddy').updater.strategy, 'replace-dir');
    const realAssets = ['loomy2api-v2.8.0.zip', 'SHA256SUMS.txt'];
    const loomyPattern = new RegExp(store.getPlatform('loomy').updater.assetPattern, 'i');
    assert.deepStrictEqual(realAssets.filter((name) => loomyPattern.test(name)), ['loomy2api-v2.8.0.zip'], 'Loomy 不能选校验文件');

    const customRoot = path.join(root, 'custom');
    fs.mkdirSync(customRoot);
    fs.writeFileSync(path.join(customRoot, 'platforms.json'), JSON.stringify({ version: 1, platforms: [
      { id: 'workbuddy', name: 'mine', type: 'go-binary', workDir: 'E:/mine', run: { binary: 'mine.exe' }, updater: {} },
    ] }));
    const existing = new ConfigStore(customRoot);
    assert.strictEqual(existing.getPlatform('workbuddy').workDir, 'E:/mine', '已有目录不能被迁移');

    const p = store.getPlatform('workbuddy');
    p.workDir = path.join(root, 'fresh');
    manager = new PlatformManager({ store, dataDir: store.dataDir });
    const updater = new PlatformUpdater({ manager, store, dataDir: store.dataDir });
    updater.check = async () => ({ checked: true, latest: '1.0.0', assetName: 'gateway.zip', assetUrl: `${base}/asset`, assetSize: payload.length, sha256: digest });
    const first = await updater.install('workbuddy');
    const second = await updater.install('workbuddy');
    assert.strictEqual(first.started, true);
    assert.strictEqual(second.started, false, '重复点击不能重复安装');
    await updater.installTasks.get('workbuddy');
    const result = updater.installStatus('workbuddy');
    assert.strictEqual(result.status, 'error', 'mock 无可执行文件时必须报告启动失败');
    assert(fs.existsSync(path.join(p.workDir, 'README.md')), '完整发布包需要安装');
    const config = JSON.parse(fs.readFileSync(path.join(p.workDir, 'config.json'), 'utf8'));
    assert.strictEqual(config.listen, '127.0.0.1:7863');
    assert.strictEqual(config.api_key.length, 64);
    assert.strictEqual(assetRequests, 1);
    const configRaw = fs.readFileSync(path.join(p.workDir, 'config.json'), 'utf8');
    updater._writeInitialConfig('workbuddy', p.workDir, p.port);
    assert.strictEqual(fs.readFileSync(path.join(p.workDir, 'config.json'), 'utf8'), configRaw, '配置不能覆盖');
    const registration = await updater.registerProvider('workbuddy');
    assert.strictEqual(registration.ok, false, '没有 magpie 时应明确报告待注册');
    assert(!registration.message.includes(config.api_key), '错误信息不能泄漏密钥');

    const occupied = path.join(root, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'accounts.json'), '{"accounts":[{"name":"keep"}]}');
    const before = fs.readFileSync(path.join(occupied, 'accounts.json'), 'utf8');
    p.workDir = occupied;
    await updater.install('workbuddy');
    await updater.installTasks.get('workbuddy');
    assert.strictEqual(updater.installStatus('workbuddy').status, 'needs-import');
    assert.strictEqual(fs.readFileSync(path.join(occupied, 'accounts.json'), 'utf8'), before, '缺主程序的旧账号目录也不能改写');
    assert(!fs.existsSync(path.join(occupied, 'config.json')), '旧数据目录不能生成新密钥');

    p.workDir = path.join(root, 'object-key');
    fs.mkdirSync(p.workDir, { recursive: true });
    fs.writeFileSync(path.join(p.workDir, 'wb2api.exe'), 'binary');
    fs.writeFileSync(path.join(p.workDir, 'config.json'), JSON.stringify({ api_keys: [{ key: 'keep-secret', region: 'cn' }] }));
    const keyResult = await updater.registerProvider('workbuddy');
    assert.strictEqual(keyResult.ok, false, '测试不调用真实 magpie');
    assert(!keyResult.message.includes('keep-secret'), '对象式密钥不得泄漏');

    const invalidProvider = await updater.registerProvider('magpie');
    assert.strictEqual(invalidProvider.ok, false, '非四网关不能走注册路径');

    const successDir = path.join(root, 'success');
    const successStore = new ConfigStore(path.join(root, 'success-data'));
    const sp = successStore.getPlatform('workbuddy');
    sp.workDir = successDir;
    sp.type = 'node';
    sp.run.binary = 'mock-healthy.js';
    sp.run.args = [];
    sp.port = 18994;
    sp.health.url = 'http://127.0.0.1:18994/healthz';
    sp.run.env = { MOCK_PORT: '18994' };
    const successManager = new PlatformManager({ store: successStore, dataDir: successStore.dataDir });
    manager = successManager;
    const successUpdater = new PlatformUpdater({ manager: successManager, store: successStore, dataDir: successStore.dataDir });
    successUpdater.registerProvider = async () => ({ ok: false, message: '测试：未安装 magpie' });
    successUpdater.check = async () => ({ checked: true, latest: '1.0.0', assetName: 'gateway.zip', assetUrl: `${base}/asset`, assetSize: payload.length, sha256: digest });
    successUpdater._mergeTree = () => {
      fs.mkdirSync(successDir, { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, 'mocks', 'mock-healthy.js'), path.join(successDir, 'mock-healthy.js'));
      sp.run.binary = process.execPath;
      sp.run.args = [path.join(successDir, 'mock-healthy.js')];
    };
    await successUpdater.install('workbuddy');
    await successUpdater.installTasks.get('workbuddy');
    assert.strictEqual(successUpdater.installStatus('workbuddy').status, 'installed-without-provider', '成功监听但无 magpie 也应保留成功安装结果');
    assert.strictEqual(successManager.getRuntime('workbuddy').cfg.type, 'node');
    console.log('PASS 新用户目录、公开 Release、下载进度/校验、完整解包、默认配置、已有路径保护、重复安装与 magpie 降级');
  } finally {
    if (manager) await manager.stopAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
