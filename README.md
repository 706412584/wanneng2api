# wanneng2api — 统一网关平台

把多个自建 2api 网关（workbuddy2api / codearts2api-panel / loomy2api / 可选 sub2api）统一到一个桌面壳：进程托管、平台启停、远程更新、轻量聚合路由。

- 权威设计文档：[docs/DESIGN.md](docs/DESIGN.md)
- 壳子模式参考 [any-auto-register](https://github.com/lxf746/any-auto-register)（Electron spawn 后端）
- 聚合层为单 Go 二进制，零第三方依赖、零数据库

## 目录结构

```
wanneng2api/
├── docs/DESIGN.md       # 权威设计文档
├── hub/                 # Hub 聚合层（Go，端口 17810）
├── shell/               # Electron 壳（Manager API 端口 17800）
└── ui/                  # React 管理界面（构建产物供壳加载）
```

## 快速开始

```bash
# 1. 构建 Hub
cd hub && go build -o hub.exe . && cd ..

# 2. 构建 UI
cd ui && pnpm install && pnpm build && cd ..

# 3. 安装壳依赖并启动
cd shell && pnpm install && pnpm dev
```

## 组件与端口

| 组件 | 端口 | 说明 |
|---|---|---|
| Manager API（壳） | 17800 | 仅 127.0.0.1，平台启停/日志/更新 |
| Hub 聚合层 | 17810 | 统一 API 入口，按模型路由 |
| workbuddy2api | 7863 | 导入模式，主程序 server.exe |
| codearts2api-panel | 7866 | 导入模式 |
| loomy2api | 17990 | 导入模式，python -m loomy2api serve |
| sub2api（可选） | 8080 | 启用时连带托管 PG:5433 + Redis:6380 |

数据目录：`%AppData%\wanneng2api\`（配置、日志、更新备份）。

## 阶段

- [ ] Phase 0：壳骨架 + 三平台托管
- [ ] Phase 1：Hub 聚合层
- [ ] Phase 2：远程更新
- [ ] Phase 3：sub2api 可选模块
- [ ] Phase 4：打包分发
