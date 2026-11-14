'use strict';

// 真实公开包临时验收：独立端口/数据目录，不读取、覆盖或重启现有网关。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../src/config');
const { PlatformManager } = require('../src/platform-manager');
const { PlatformUpdater } = require('../src/updater');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  process.env.WANNENG_DISABLE_SYSTEM_MAGPIE = '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-public-smoke-'));
  const store = new ConfigStore(path.join(root, 'data'));
  const manager = new PlatformManager({ store, dataDir: store.dataDir });
  const updater = new PlatformUpdater({ manager, store, dataDir: store.dataDir });
  const requested = process.argv.slice(2).filter((id) => ['workbuddy', 'codearts', 'loomy', 'lingxi'].includes(id));
  const ids = requested.length ? requested : ['workbuddy', 'codearts', 'lingxi', 'loomy'];
  console.log(`临时目录: ${root}`);
  try {
    for (const id of ids) {
      const p = store.getPlatform(id);
      const port = await freePort();
      p.port = port;
      p.health.url = `http://127.0.0.1:${port}${new URL(p.health.url).pathname}`;
      p.adminPanel = `http://127.0.0.1:${port}/`;
      console.log(`[${id}] 开始安装到 ${store.platformWorkDir(p)}，测试端口 ${port}`);
      await updater.install(id);
      await updater.installTasks.get(id);
      const result = updater.installStatus(id);
      console.log(`[${id}] ${result.status}: ${result.message}`);
      if (!['installed', 'installed-without-provider'].includes(result.status)) {
        console.log(manager.tailLogs(id, 20).join('\n'));
        throw new Error(`${id} 安装失败`);
      }
      if (result.status === 'installed-without-provider') console.log(`[${id}] 网关安装已完成；不连接真实 magpie 做注册测试`);
      await manager.stop(id);
    }
    console.log('PASS 公开包下载、校验、解包、独立配置和临时进程健康验证');
  } finally {
    await manager.stopAll().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
