'use strict';
/**
 * tray.js — 系统托盘（DESIGN.md §4.6）
 *
 * 菜单：显示主界面 / 各平台启停（状态灯） / 退出（反序 stop 平台后 quit）
 * 纯函数式：由 main.js 注入依赖（manager / showMainWindow / appQuit）。
 */

const { Tray, Menu, nativeImage } = require('electron');

let tray = null;

/** 生成一个纯色圆点图标（无外部资源依赖，SVG data URL 由 Chromium 解码） */
function statusIcon(color) {
  const size = 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );
}

const STATE_COLORS = {
  healthy: '#35c759',
  starting: '#f5a623',
  degraded: '#f5a623',
  unhealthy: '#ff453a',
  error: '#ff453a',
  updating: '#3f8cff',
  stopped: '#8e8e93',
};

function createTray({ manager, store, showMainWindow, appQuit }) {
  tray = new Tray(statusIcon('#8e8e93'));
  tray.setToolTip('Wanneng2API');
  tray.on('click', () => showMainWindow());
  rebuildTrayMenu({ manager, store, showMainWindow, appQuit, trayRef: tray });
  return tray;
}

function rebuildTrayMenu({ manager, store, showMainWindow, appQuit, trayRef }) {
  const t = trayRef || tray;
  if (!t) return;

  const items = [
    { label: '显示主界面', click: () => showMainWindow() },
    { type: 'separator' },
  ];

  for (const snap of manager.statusList()) {
    const cfg = store.getPlatform(snap.id) || {};
    const color = STATE_COLORS[snap.status] || '#8e8e93';
    items.push({
      label: `${cfg.name || snap.id}  [${snap.status}]`,
      icon: statusIcon(color),
      submenu: [
        snap.status === 'stopped' || snap.status === 'error'
          ? {
              label: '启动',
              click: () => manager.start(snap.id).catch(() => {}),
            }
          : {
              label: '停止',
              click: () => manager.stop(snap.id).catch(() => {}),
            },
        {
          label: '重启',
          click: () => manager.restart(snap.id).catch(() => {}),
        },
        cfg.adminPanel
          ? {
              label: '打开面板',
              click: () => require('electron').shell.openExternal(cfg.adminPanel),
            }
          : { label: '（无面板）', enabled: false },
      ],
    });
  }

  items.push(
    { type: 'separator' },
    {
      label: '退出（反序停止全部平台）',
      click: async () => {
        try { await manager.stopAll(); } catch (_e) { /* ignore */ }
        appQuit();
      },
    },
  );

  t.setContextMenu(Menu.buildFromTemplate(items));
}

function destroyTray() {
  if (tray) {
    try { tray.destroy(); } catch (_e) { /* ignore */ }
    tray = null;
  }
}

module.exports = { createTray, rebuildTrayMenu, destroyTray };
