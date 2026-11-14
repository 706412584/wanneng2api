'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SelfUpdater } = require('../src/self-updater');

class FakeUpdater extends EventEmitter {
  constructor() { super(); this.quitCalls = 0; this.downloadCalls = 0; }
  async checkForUpdates() {
    const info = { version: '0.2.0' };
    this.emit('update-available', info);
    return { updateInfo: info };
  }
  async downloadUpdate() {
    this.downloadCalls++;
    this.emit('download-progress', { percent: 52.5, transferred: 50, total: 100, bytesPerSecond: 10 });
    this.emit('update-downloaded', { version: '0.2.0' });
  }
  quitAndInstall() { this.quitCalls++; }
}

async function main() {
  const updater = new FakeUpdater();
  let cleanup = 0;
  const controller = new SelfUpdater(updater, {
    currentVersion: '0.1.0', supported: true,
    beforeInstall: async () => { cleanup++; },
  });
  assert.strictEqual(updater.autoDownload, false);
  assert.strictEqual(updater.autoInstallOnAppQuit, false);
  const checked = await controller.check();
  assert.strictEqual(checked.status, 'available');
  assert.strictEqual(updater.quitCalls, 0, '检查更新不能重启');
  await controller.download();
  assert.strictEqual(updater.downloadCalls, 1);
  assert.strictEqual(controller.status().status, 'downloaded');
  assert.strictEqual(updater.quitCalls, 0, '下载完成不能重启');
  await controller.install();
  assert.strictEqual(cleanup, 1, '安装前必须正常停止平台');
  assert.strictEqual(updater.quitCalls, 1, '只有确认安装才能重启');

  const downloading = new FakeUpdater();
  downloading.downloadUpdate = () => new Promise(() => {});
  const pending = new SelfUpdater(downloading, { currentVersion: '0.1.0' });
  await pending.download();
  downloading.emit('download-progress', { percent: 30, transferred: 30, total: 100 });
  assert.strictEqual(pending.status().status, 'downloading');
  assert.strictEqual(pending.status().percent, 30);
  assert.strictEqual(downloading.quitCalls, 0);
  console.log('PASS 壳更新检查、下载进度、下载完成不退出、确认重启与退出前清理');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
