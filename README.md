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
│   └── src/tunnel/      # 统一外网访问：Cloudflare、受限网关、远程认证
└── ui/                  # React 管理界面（构建产物供壳加载）
    └── src/pages/ExternalAccess.jsx  # 外网访问页（折叠卡片 + 配置弹窗）
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
| 外网安全入口 | 17901-17906 | 仅 127.0.0.1，依次对应四网关、magpie、管理台 |
| magpie 统一入口 | 3425 | 四协议互译与路由 |
| magpie 控制台 | 17899 | 壳托管的 Web 管理台 |
| workbuddy2api | 7863 | 可一键安装或导入，主程序 wb2api(.exe) |
| codearts2api-panel | 7866 | 可一键安装或导入 |
| loomy2api | 17990 | 可一键安装或导入，python -m loomy2api serve |
| lingxi2api | 6789 | 可一键安装或导入，公开 Release |
| sub2api（可选） | 8080 | 启用时连带托管 PG:5433 + Redis:6380 |

## Hub 聚合与模型别名

- 「外网访问」的 **Magpie 公网模型别名**折叠卡片用于选择 aliases 同步目标 Key，并逐个授权自建、本地及社区 provider。不会默认选择第一把 Key，也不会改变隧道当前接受哪些 caller keys。
- 唯一裸名映射到 `provider/model`；跨 provider 同名模型只使用成员全部已授权且精确匹配的静态 Hub 路由组。无法安全解析时保留冲突提示，不静默选择第一家，不自动建组或开放 `all`、`auto/*`。
- 已授权 provider 在启动、相关变更及每 10 分钟刷新模型；magpie 原生 `Refetch/dropGonePicks` 负责持久化下架模型，同步器再收敛 Models/Aliases。刷新失败沿用上次目录，不当作全部删除。每 Key aliases 上限 200、Models 上限 500。
- 首次授权可接管该 provider 的现有 direct aliases 和 `provider/*`，收敛为明确启用模型；无关手工映射与 Accounts 限制保留。外部修改会报告冲突而不反复覆盖，外部删除会持久抑制，只有重新明确授权该 provider 才恢复。最后撤销绝不写入可能表示“不限制”的空 Models：没有手工 Models、aliases 和 Accounts 时才改为禁用目标 Key，且只自动重新启用同步器自己禁用的 Key。
- 四家自建 provider 的普通 API Key 自动从各自本机 config/env 同步；已有 provider 只执行 `provider key`，缺失才由安装或手动注册创建。社区/本地插件凭证始终由 magpie 管理，壳不读取或复制。
- Hub「模型优先级」展示全部自定义路由组和多成员自动组，单成员绑定也可管理。自定义组可删除，删除前显示名称与确认框；自动合并组禁止删除。删除只影响路由入口，不修改 provider、账号或模型。

## 灵犀连败降权

连败降权采用严格硬冷却：未到期不会进入“全冷却兜底”，降权前旧在途请求成功也不会提前解除；到期后惰性恢复。人工「解冻」清除连败计数和降权截止，并可跨重启保持。「恢复选号」与「暂停选号」分别调用原生 resume/pause。此行为以部署包含该修复的灵犀版本为准。

## 外网访问

「外网访问」页统一管理 WorkBuddy、CodeArts、Loomy、Lingxi、magpie 和远程管理台，支持 Cloudflare Quick Tunnel（临时地址）与 Named Tunnel（固定域名）。cloudflared 使用固定版本 `2026.10.6`，首次启动时下载并校验 SHA-256。

- **不改变 LAN 配置**：隧道指向独立 loopback 安全入口，不修改原网关监听地址，也不会自动启动或重启既有网关。
- **API 目标只开放模型路由**：逐请求校验现有普通 API Key，管理面板、账号、配置和日志路径默认拒绝。CodeArts 的 `admin_key` 不能代替普通 API Key；magpie 需先在 Gateway keys 中创建并启用一个 Key。
- **Named 配置**：按“Token → 验证 → Public Hostname”顺序操作。验证进程在 Cloudflare 注册成功后立即停止并记录 `verifiedAt/tunnelId`，未验证或 Token 已修改时不能编辑域名或启动。每个目标使用独立 Tunnel Token 和 Public Hostname；Cloudflare 控制台中的 Service URL 填页面展示的 `http://127.0.0.1:<入口端口>`，应用不会自动创建 Tunnel、DNS 或 ingress。
- **远程管理台**：先在本机配置弹窗中设置至少 12 位管理员密码。公网请求必须经过登录、会话、CSRF、Origin/Host 与限流校验，现有 Manager API `:17800` 不直接暴露。远程日志自动使用去重轮询，避免部分 Cloudflare 链路不转发 SSE 时页面空等。
- 卡片默认折叠且高度统一；配置和日志分别在弹窗中操作。Token 只写入、不回显，远程密码不进入 localStorage。

数据目录：`%AppData%\wanneng2api\`（配置、日志、更新备份）。

## 自更新

「更新中心」可检查并下载壳更新，展示下载百分比和字节数。下载完成后先确认，再停止托管平台并重启安装；普通检查、下载和关闭窗口不会自动安装。
