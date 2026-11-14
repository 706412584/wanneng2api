# wanneng2api — 统一网关平台

把多个自建 2api 网关（WorkBuddy / CodeArts / Loomy / Lingxi / 可选 sub2api）统一到一个桌面壳：首次安装、进程托管、平台启停、远程更新与 magpie 聚合路由。

- 权威设计文档：[docs/DESIGN.md](docs/DESIGN.md)
- 壳子模式参考 [any-auto-register](https://github.com/lxf746/any-auto-register)（Electron spawn 后端）
- 聚合层由外部 magpie 提供，统一入口为 `127.0.0.1:3425`
- 四个网关首次安装使用公开 Release，不会下载或覆盖已有目录中的账号数据

## 目录结构

```
wanneng2api/
├── docs/DESIGN.md       # 权威设计文档
├── plugins/             # magpie 请求改写 middleware
├── shell/               # Electron 壳（Manager API 端口 17800）
└── ui/                  # React 管理界面（构建产物供壳加载）
```

## 快速开始

```bash
# 1. 构建 UI
cd ui && npm install && npm run build && cd ..

# 2. 安装壳依赖并启动
cd shell && npm install && npm start
```

首次使用时在「平台管理」点击各网关的「安装」。安装到用户数据目录后，壳会生成本机配置、验证端口并尝试注册到 magpie；空账号池不代表安装失败，进入「管理」添加账号即可。已保存的导入目录、配置和账号文件保持不变。

Loomy 需要 Python 3.9+（未捆绑解释器时使用系统 Python）。首次安装支持 Windows x64，以及具有对应 Release 资产的 Linux x64/ARM64。

## 组件与端口

| 组件 | 端口 | 说明 |
|---|---|---|
| Manager API（壳） | 17800 | 仅 127.0.0.1，平台启停/日志/更新 |
| magpie 统一入口 | 3425 | 四协议互译与路由 |
| magpie 控制台 | 17899 | 壳托管的 Web 管理台 |
| workbuddy2api | 7863 | 可一键安装或导入，主程序 wb2api(.exe) |
| codearts2api-panel | 7866 | 可一键安装或导入 |
| loomy2api | 17990 | 可一键安装或导入，python -m loomy2api serve |
| lingxi2api | 6789 | 可一键安装或导入，公开 Release |
| sub2api（可选） | 8080 | 启用时连带托管 PG:5433 + Redis:6380 |

数据目录：`%AppData%\wanneng2api\`（配置、日志、更新备份）。

## 自更新

「更新中心」可检查并下载壳更新，展示下载百分比和字节数。下载完成后先确认，再停止托管平台并重启安装；普通检查、下载和关闭窗口不会自动安装。
