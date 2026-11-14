'use strict';

/**
 * 壳自更新状态机。Electron 的 autoUpdater 通过构造参数注入，方便无窗口回归。
 * 只有 install() 会触发重启；检查、下载以及下载完成都不会退出应用。
 */
class SelfUpdater {
  constructor(updater, { currentVersion = '', supported = true, reason = '', beforeInstall = null } = {}) {
    this.updater = updater;
    this.currentVersion = currentVersion;
    this.supported = supported;
    this.reason = reason;
    this.beforeInstall = beforeInstall;
    this.state = { status: 'idle', current: currentVersion, supported, reason };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on('update-available', (info) => {
      this.state = { ...this.state, status: 'available', latest: info.version, error: '' };
    });
    updater.on('update-not-available', () => {
      this.state = { ...this.state, status: 'idle', latest: currentVersion, hasUpdate: false };
    });
    updater.on('download-progress', (progress) => {
      this.state = {
        ...this.state,
        status: 'downloading',
        percent: Number(progress.percent) || 0,
        received: Number(progress.transferred) || 0,
        total: Number(progress.total) || 0,
        bytesPerSecond: Number(progress.bytesPerSecond) || 0,
      };
    });
    updater.on('update-downloaded', (info) => {
      this.state = { ...this.state, status: 'downloaded', latest: info.version || this.state.latest, percent: 100 };
    });
    updater.on('error', (error) => {
      this.state = { ...this.state, status: 'error', error: error.message };
    });
  }

  status() {
    return { ...this.state, current: this.currentVersion, supported: this.supported, reason: this.reason };
  }

  _unsupported() {
    return { supported: false, reason: this.reason, current: this.currentVersion };
  }

  async check() {
    if (!this.supported) return this._unsupported();
    this.state = { ...this.state, status: 'checking', error: '' };
    try {
      const result = await this.updater.checkForUpdates();
      const latest = result && result.updateInfo && result.updateInfo.version;
      this.state = {
        ...this.state,
        status: latest && latest !== this.currentVersion ? 'available' : 'idle',
        latest: latest || this.currentVersion,
        hasUpdate: !!(latest && latest !== this.currentVersion),
      };
      return this.status();
    } catch (error) {
      this.state = { ...this.state, status: 'error', error: error.message };
      throw error;
    }
  }

  async download() {
    if (!this.supported) return this._unsupported();
    if (this.state.status === 'downloaded') return this.status();
    if (this.state.status !== 'downloading') {
      this.state = { ...this.state, status: 'downloading', percent: 0, received: 0, total: 0, error: '' };
      // Promise 留在后台完成，HTTP 只负责下发；进度由 status() 轮询。
      this.updater.downloadUpdate().catch((error) => {
        this.state = { ...this.state, status: 'error', error: error.message };
      });
    }
    return this.status();
  }

  async install() {
    if (!this.supported) return this._unsupported();
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    if (this.beforeInstall) await this.beforeInstall();
    this.updater.quitAndInstall();
    return { ok: true };
  }
}

module.exports = { SelfUpdater };
