// preload.js — 只暴露窗口控制与少量宿主信息给渲染进程。
// 主窗口是 frame:false 的自绘标题栏，需要这些 IPC 才能最小化/最大化/关闭。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wannengShell', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  // 登录页：system = 系统默认浏览器；incognito = 壳内无痕窗口（独立
  // session 分区、不落盘、关闭即清）。返回 {ok, mode} 或 {ok:false, error}。
  openLogin: (url, mode = 'system') => ipcRenderer.invoke('login:open', { url, mode }),
  // 最大化状态变化时回调，按钮图标要跟着切换
  onMaximizeChange: (cb) => {
    const handler = (_e, v) => cb(v)
    ipcRenderer.on('window:maximized', handler)
    return () => ipcRenderer.removeListener('window:maximized', handler)
  },
})