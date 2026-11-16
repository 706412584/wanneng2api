'use strict';

const { TunnelStore } = require('./tunnel-store');
const { TargetAdapters } = require('./target-adapters');
const { TunnelManager } = require('./tunnel-manager');

function createTunnelSystem({ configStore, dataDir, managerOrigin, staticDir, proxy, logger, ...options }) {
  const store = new TunnelStore(dataDir || (configStore && configStore.dataDir));
  const adapters = new TargetAdapters({
    getPlatform: (id) => configStore.getPlatform(id),
    resolveWorkDir: (platform) => configStore.platformWorkDir(platform),
    ...(options.adaptersOptions || {}),
  });
  const manager = new TunnelManager({
    store,
    adapters,
    managerOrigin,
    staticDir,
    proxy,
    logger,
    ...options,
  });
  return { store, adapters, manager };
}

module.exports = {
  createTunnelSystem,
  TunnelStore,
  TargetAdapters,
  TunnelManager,
  ...require('./targets'),
};
