# Wanneng2API — 统一网关平台完整设计方案

> 定位：把现有的多个 2api 网关（workbuddy2api / codearts2api-panel / loomy2api / 可选 sub2api）统一到一个**桌面壳 + 平台管理 + 轻量聚合层**的平台上。
> 壳子参考 `D:\软件\any-auto-register`（Electron spawn 后端模式），底层可选接入 `D:\sub2api-custom`。
> 本文档是项目的权威设计文档，实现以其为准。

---

## 0. 结论先行（关键决策记录）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不给 sub2api 换 SQLite** | `backend/internal/repository/ent.go:126` 硬编码 `dialect.Postgres` + pq 驱动；SQL 迁移文件是 PG 专用语法（权威 schema）；多处仓库代码判断 `dialect.Postgres` 走特殊分支（`api_key_repo.go:567` 等）；Redis 也是硬依赖（rate_limiter、IM hub）。换 SQLite = 重写迁移体系 + 所有 PG 分支，按周计工作量且引入并发锁风险 |
| D2 | sub2api 作为**可选平台**，仅在需要多用户分发/计费时启用，连带托管嵌入式 PG + Redis | 自用场景下三个网关 + 轻聚合层已覆盖 90% 需求；sub2api 重栈按需拉起 |
| D3 | 三个现有网关**保持原端口、原配置、原面板**，壳子只做进程托管 | 它们已完成协议翻译/账号池/冷却，壳子不侵入 |
| D4 | ~~聚合层（Hub）为单 Go 二进制、JSON 配置、零 DB~~ **改为：不自研 Hub，统一调用层交给 magpie** | `yetone/magpie`（33.6k stars，Go，MIT，Windows/macOS/Linux，菜单栏 App + Web UI + TUI + CLI）已完整实现：`127.0.0.1:3425` 单入口同时支持 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四协议并自动互译；自定义 provider 支持 `url=`（OpenAI 兼容）与 `anthropic=`（Anthropic 兼容）；账号/quota 耗尽自动切号 + routing group 跨模型跨 provider 故障转移；quota/usage/CSV/JSON 查询。三个网关对它而言就是三个 custom provider，自研 Hub 属完全重复实现 |
| D4b | 壳**直接调 magpie CLI** 做集成，而非仅出指引 | `magpie provider add "<name>" url=… anthropic=… key=… models=…` 可编程添加 provider；`magpie providers` / `magpie quota --json` / `magpie usage --json` 提供可解析状态 |
| D5 | 数据目录统一收口到 `%AppData%\wanneng2api\`，同时支持「导入模式」引用现有目录 | 用户现有数据（账号池、auths）宝贵，不强制迁移 |
| D6 | 壳子用 Electron，管理 API 内嵌在主进程（不再 spawn 独立管理后端） | 比 any-auto-register（Python 后端）更简单；Node http 模块即可 |

---

## 1. 总体架构

```
┌─ Agent（Claude Code / Codex / Gemini CLI / 任意 OpenAI SDK）
│   只认一个 base_url：http://127.0.0.1:3425
▼
┌─────────────────────────────────────────────────────────────────────────┐
│ magpie 网关 :3425                                                        │
│  · 四协议互译（OpenAI Chat / OpenAI Responses / Anthropic / Gemini）     │
│  · routing group：跨模型、跨 provider 故障转移、账号/quota 切换          │
│  · quota 面板、用量统计、给所有 agent 自动改写配置                       │
│  └─ middleware 插件（本项目自研，零 fork）                               │
│      ├─ prompt-guard        系统提示词改写（消灭 system 指纹误报）       │
│      └─ fingerprint-sanitize 出站指纹脱敏（sanitize blacklist）          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ custom provider（url= / anthropic=）
   ┌────────────┬───────────────┼───────────────┬────────────────┐
   ▼            ▼               ▼               ▼                ▼
┌─────────┐ ┌─────────┐ ┌──────────────┐ ┌───────────┐ ┌────────────────┐
│workbuddy│ │codearts │ │loomy         │ │lingxi     │ │sub2api（可选） │
│:7863    │ │:7866    │ │:17990        │ │:6789      │ │:8080           │
│Go exe   │ │Go exe   │ │Python 标准库 │ │Go exe     │ │ ├ PG :5433     │
│多账号池 │ │多账号池 │ │多账号池      │ │多账号池   │ │ └ Redis :6380  │
└─────────┘ └─────────┘ └──────────────┘ └───────────┘ └────────────────┘
     ▲           ▲              ▲             ▲                  ▲
     └───────────┴──────────────┴─────────────┴──────────────────┘
                    进程托管 / 健康巡检 / 远程更新 / 日志
┌─────────────────────────────────────────────────────────────────────────┐
│  Electron 壳（wanneng2api）                                              │
│  · PlatformManager：spawn / 健康巡检 / 崩溃退避重启 / 端口预检          │
│  · Manager API :17800（仅 127.0.0.1）                                    │
│  · React UI 六页：概览 / 平台管理 / 更新中心 / Hub / 日志 / 设置         │
│  · 托盘 / 开机自启 / 更新器（replace-binary / replace-dir + 回滚）       │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键点：为什么自研网关保留在下层**

magpie 的社区插件（`opencode-workbuddy-auth` / `opencode-codearts-auth` /
`opencode-loomy-auth`）原生覆盖了三家平台的登录与转发，但插件 API 不支持多账号池
（workbuddy 插件 README 自述 "Not here … several accounts under one provider"）。
自研网关保留的是 magpie 插件做不了的那一层：

| 能力 | magpie 插件 | 自研网关 |
|---|---|---|
| 登录 / 转发 / 模型列表 / 签到 | ✅ | ✅ |
| 多账号池、加权随机、防惊群、在途租约 | ❌ | ✅ |
| 按实测扣费的成本优先选号 | ❌ | ✅ |
| 会话粘性（多轮上下文不跳号） | 部分（网关层） | ✅ |
| 账号分组 / 分组代理 | ❌ | ✅ |
| 活动 / 旅行 / 保活等定时任务 | ❌ | ✅ |

因此不 fork 上游插件（fork 4000+ 行、每次上游更新都要合并），而是：
**协议层用 magpie，账号治理层用自研网关，定制改写层用 middleware。**

**灵犀（lingxi2api）的定位**：magpie 社区没有灵犀插件，但灵犀网关只提供
OpenAI 协议（`/v1/messages` 明确留给未来实现，当前 404）。由 magpie 网关负责
把 Anthropic 请求翻译成 OpenAI 发给它，因此无需给灵犀补协议层。

**职责边界**（最重要的设计约束）：

| 组件 | 职责 | 明确不做 |
|---|---|---|
| 壳子 | 进程生命周期、平台卡管理、远程更新、托盘/自启、日志收集 | 不碰任何 API 流量、不理解 2api 协议 |
| magpie | 统一入口、四协议互译、routing group、故障转移、quota/用量 | 不做账号池、不管理上游进程 |
| middleware | 出站改写（系统提示词、指纹脱敏） | 不参与路由、不持有账号 |
| 各网关 | 账号池/冷却/选号/粘性/分组/定时任务 | 不做协议互译（交给 magpie） |
| sub2api | 多用户分发/计费（启用时） | — |

**壳子对 magpie 是 `external` 平台**：只探测 `:3425` 存活并反映到状态灯，
不 spawn、不停止、不更新——它的生命周期归 magpie 自己。

---

## 2. 端口分配表

| 端口 | 用途 | 来源 |
|---|---|---|
| **17800** | 壳子 Manager API（仅 127.0.0.1） | 新增 |
| **3425** | magpie 统一网关（外部托管，壳只探测） | magpie 默认（`MAGPIE_ADDR` 可改） |
| **6789** | lingxi2api | 保持不变（config.json `listen`） |
| **17810** | Hub 统一 API 入口（127.0.0.1，可配置对外） | 新增 |
| 7863 | workbuddy2api | 保持不变（config.json `listen`） |
| 7866 | codearts2api-panel | 保持不变 |
| 17990 | loomy2api | 保持不变（注意：config.json 是 17990，README 写的 17890 以配置为准） |
| 8080 | sub2api server（启用时） | sub2api 默认值，可改 |
| 5433 | 嵌入式 PostgreSQL（避开系统 5432） | 新增，仅启用 sub2api 时 |
| 6380 | 嵌入式 Redis/Memurai（避开系统 6379） | 新增，仅启用 sub2api 时 |

壳子启动时对全部启用平台的端口做**预检**（占用检测），冲突则卡片显示红色告警而不盲目 spawn。

---

## 3. 数据目录设计

```
%AppData%\wanneng2api\
├── manager.json                 # 壳子全局配置（见 §4.1）
├── platforms.json               # 平台注册表（见 §4.2）
├── logs\
│   ├── manager.log              # 壳子自身日志
│   └── platforms\<id>.log       # 各平台 stdout/stderr（按 10MB 轮转，保留 5 份）
├── hub\
│   ├── hub.json                 # Hub 配置（见 §6.1）
│   ├── usage\                   # 用量 JSONL 落盘（YYYYMMDD.jsonl）
│   └── state.json               # Hub 冷却/健康状态快照（重启恢复）
├── platforms\
│   ├── workbuddy\               # 「托管模式」下各平台的工作目录
│   │   ├── config.json
│   │   ├── auths\
│   │   └── data\
│   ├── codearts\ ...
│   ├── loomy\ ...
│   └── sub2api\
│       ├── config.yaml
│       └── data\
├── deps\                        # 便携依赖（sub2api 启用时）
│   ├── pg15\                    # PostgreSQL 15 免安装版
│   └── redis\                   # Memurai/Redis 便携版
└── updates\
    └── <platform>\              # 更新下载暂存
```

**导入模式**：`platforms.json` 中平台的 `workDir` 指向现有目录（如 `D:/软件/workbuddy2api`、`D:/app/loomy2api`）。壳子对导入目录**只写日志/备份，不改配置结构**；首次导入时自动备份一份原 config 到 `updates/<id>/import-backup/`。这是保护用户现有账号池数据的关键设计。

---

## 4. 壳子层详细设计

### 4.1 manager.json（壳子配置）

```json
{
  "general": {
    "language": "zh-CN",
    "theme": "auto",
    "closeAction": "tray",          // tray | quit
    "autoStart": true,              // 开机自启（app.setLoginItemSettings）
    "startMinimized": true,
    "autoStartPlatforms": ["workbuddy", "codearts", "loomy", "hub"],
    "autoStartDelaySec": 0
  },
  "manager": {
    "listen": "127.0.0.1:17800",
    "logLevel": "info"
  },
  "update": {
    "checkOnLaunch": true,
    "channel": "stable",
    "githubToken": "",              // 可选，避免 rate limit
    "keepBackups": 3
  },
  "sub2api": {
    "pgPort": 5433,
    "redisPort": 6380,
    "dataDir": ""                   // 空 = 默认 platforms/sub2api
  }
}
```

### 4.2 platforms.json（平台注册表）

```json
{
  "version": 1,
  "platforms": [
    {
      "id": "workbuddy",
      "name": "WorkBuddy2API",
      "type": "go-binary",
      "enabled": true,
      "mode": "managed",                       // managed=壳子全托管 | import=引用现有目录
      "workDir": "C:/Users/<u>/AppData/Roaming/wanneng2api/platforms/workbuddy",
      "run": {
        "binary": "workbuddy2api.exe",         // 相对 workDir；workbuddy 含多个 exe，主程序由此指定
        "args": [],
        "env": { "NO_PROXY": "*" },            // 清代理，参考 AAR backendEnv
        "shell": false
      },
      "port": 7863,
      "health": {
        "url": "http://127.0.0.1:7863/healthz",
        "intervalSec": 15,
        "timeoutSec": 3,
        "failThreshold": 3,                    // 连续失败→unhealthy
        "okThreshold": 1                       // 任一成功→healthy
      },
      "adminPanel": "http://127.0.0.1:7863/__admin/",
      "updater": {
        "repo": "<owner>/workbuddy2api",
        "assetPattern": "workbuddy2api.*windows.*amd64\\.exe$",
        "strategy": "replace-binary"           // 单文件替换
      },
      "restart": { "baseBackoffSec": 2, "maxBackoffSec": 300, "maxRetries": 0 }
    },
    {
      "id": "codearts",
      "name": "CodeArts2API Panel",
      "type": "go-binary",
      "enabled": true,
      "mode": "managed",
      "workDir": "%APPDATA%/wanneng2api/platforms/codearts",
      "run": { "binary": "codearts2api-panel.exe", "args": [], "env": { "NO_PROXY": "*" } },
      "port": 7866,
      "health": { "url": "http://127.0.0.1:7866/v1/models", "intervalSec": 15, "timeoutSec": 3, "failThreshold": 3, "okThreshold": 1 },
      "adminPanel": "http://127.0.0.1:7866/",
      "updater": { "repo": "<owner>/codearts2api-panel", "assetPattern": ".*windows.*\\.exe$", "strategy": "replace-binary" },
      "restart": { "baseBackoffSec": 2, "maxBackoffSec": 300, "maxRetries": 0 }
    },
    {
      "id": "loomy",
      "name": "Loomy2API",
      "type": "python-module",
      "enabled": true,
      "mode": "import",                        // 首期直接引用 D:/app/loomy2api
      "workDir": "D:/app/loomy2api",
      "run": {
        "pythonPath": "bundled",               // bundled=壳子捆绑的 python-embed；否则填系统 python.exe 路径
        "module": "loomy2api",
        "args": ["serve"],
        "env": { "NO_PROXY": "*", "PYTHONIOENCODING": "utf-8" }
      },
      "port": 17990,
      "health": { "url": "http://127.0.0.1:17990/health", "intervalSec": 15, "timeoutSec": 3, "failThreshold": 3, "okThreshold": 1 },
      "adminPanel": "http://127.0.0.1:17990/panel",
      "updater": { "repo": "706412584/loomy2api", "assetPattern": ".*\\.zip$", "strategy": "replace-dir" },
      "restart": { "baseBackoffSec": 2, "maxBackoffSec": 300, "maxRetries": 0 }
    },
    {
      "id": "sub2api",
      "name": "Sub2API（可选）",
      "type": "go-binary",
      "enabled": false,                        // 默认关闭；启用时自动托管 PG + Redis
      "mode": "managed",
      "workDir": "%APPDATA%/wanneng2api/platforms/sub2api",
      "requires": ["pg", "redis"],             // 见 §8
      "run": { "binary": "server.exe", "args": [], "env": { "NO_PROXY": "*" } },
      "port": 8080,
      "health": { "url": "http://127.0.0.1:8080/api/health", "intervalSec": 20, "timeoutSec": 5, "failThreshold": 3, "okThreshold": 1 },
      "adminPanel": "http://127.0.0.1:8080/",
      "updater": { "repo": "Wei-Shaw/sub2api", "assetPattern": ".*windows.*amd64\\.zip$", "strategy": "replace-dir" },
      "restart": { "baseBackoffSec": 5, "maxBackoffSec": 600, "maxRetries": 0 }
    }
  ]
}
```

> 各平台的 health URL 与主 exe 文件名是实现前需逐一实测确认的点（workbuddy 已确认有 `/healthz`；loomy 已确认有 `/health`；codearts 用 `/v1/models` 作为轻量探活，实现时核对）。

### 4.3 PlatformManager（壳子主进程核心模块）

**平台状态机**：

```
stopped ──start──► starting ──health ok──► healthy
   ▲                  │                        │
   │             spawn失败/               health 连续 fail
   │             端口预检失败                  ▼
   │                  ▼                    degraded ──继续失败──► unhealthy
   │              error ◄────crash──────────┘
   │                  │  进程退出（非人为 stop）
   │                  └──► backoff(2s→4s→…→300s) 自动重启 → starting
   └──stop──┴─────────────────────────────────────────
更新期间状态：updating（禁止 start/stop）
```

**核心职责**：

1. **spawn 管理**：`child_process.spawn(binary, args, { cwd: workDir, env: {...process.env, ...platform.env}, windowsHide: true })`。每个平台同时最多一个实例（manager 是唯一 owner，天然防双开）。
2. **stdout/stderr 收集**：管道接入轮转文件 `logs/platforms/<id>.log`，同时保留最近 500 行环形缓冲供 UI SSE 实时推送。
3. **健康巡检**：定时器按 `health.intervalSec` 探活；`failThreshold` 次连续失败 → degraded；进程退出但非用户 stop → crash 分支，指数退避自动拉起。
4. **依赖编排**（仅 sub2api）：start 前先按序拉起 pg → redis（等待各自就绪），stop 时反序关闭。
5. **端口预检**：spawn 前探测目标端口是否被占（非本平台 PID 占用则报 `port-conflict`）。
6. **优雅停止**：Windows 下 `taskkill /pid <pid> /t` 前先尝试 `process.kill(pid)` + 给 3s 退出窗口，超时强杀。

### 4.4 Manager API（内嵌在 Electron 主进程，仅绑定 127.0.0.1）

```
GET    /api/overview                     概览：平台状态汇总 + Hub 状态 + 端口占用 + 资源占用
GET    /api/platforms                    平台列表（含状态、版本、pid、uptime、最近错误）
POST   /api/platforms/:id/start|stop|restart|enable|disable
GET    /api/platforms/:id/detail         单平台详情（配置摘要 + 健康历史 + 最近崩溃原因）
GET    /api/platforms/:id/logs?tail=200  最近 N 行
GET    /api/platforms/:id/logs/stream    SSE 实时日志流
POST   /api/platforms/:id/update/check   检查远程新版本 → {current, latest, assetUrl, notes}
POST   /api/platforms/:id/update/apply   执行更新（见 §7）
POST   /api/platforms/:id/open-panel     打开系统浏览器访问该平台管理面板
GET    /api/hub/status                   Hub 运行状态 + 路由表
POST   /api/hub/reload                   热重载 hub.json
GET/PUT /api/settings                    manager.json 读写
GET    /api/updates/summary              全平台版本汇总（UI「更新中心」页数据源）
```

安全约束：仅监听 127.0.0.1；CORS 仅允许 `file://`（壳 UI）与 127.0.0.1；无需 token（本地进程）。UI 与 API 的通路：渲染进程直接 fetch `http://127.0.0.1:17800`。

### 4.5 壳子 UI（沿用 any-auto-register 风格）

页面结构（React + Vite，构建产物打进 electron `resources/ui/`）：

| 页面 | 内容 |
|---|---|
| 概览 | 顶部 6 项指标卡（运行平台数 / Hub 状态 / 今日请求 / 今日 token / 健康告警 / 待更新数）+ 平台健康时间线 |
| 平台管理 | 每平台一张卡：状态灯、版本、uptime、启停按钮、健康、打开面板按钮、更新按钮（有新版显示徽标）、日志入口。sub2api 卡额外显示 PG/Redis 依赖状态 |
| 更新中心 | 全平台版本对照表 + 「一键检查」「逐个/批量更新」+ 更新进度实时流 + 失败回滚记录 |
| Hub | 模型路由表（模型模式 → 平台链）、统一入口地址展示（一键复制 base_url + key）、实时用量表 |
| 日志 | 平台多选 + 实时流 + 级别过滤 + 搜索 |
| 设置 | manager.json 全部字段 + 平台启用开关 + sub2api 依赖端口设置 + 关于/检查壳更新 |

交互细节沿用 AAR：浅色/深色主题、启动 Splash（等待各平台健康通过）、托盘菜单（显示主界面 / 启停各平台 / 退出）。

### 4.6 壳子生命周期

```
启动 → single-instance lock → 读 manager.json/platforms.json → Splash 窗口
     → 按需 spawn Hub + autoStartPlatforms → 逐个 waitForHealth（同 AAR waitForBackend 轮询，上限 180×1s）
     → 全部通过/超时 → 加载主 UI → 托盘就绪
关闭（closeAction=tray）：窗口隐藏，进程保留
退出（托盘→退出）：反序 stop 平台 → flush 日志 → app.quit
崩溃恢复：壳子下次启动时检测 updates/<id>/.updating 残留 → 回滚后启动
```

---

## 5. 平台适配器规格（实现清单）

| 平台 | 类型 | 启动方式 | 健康端点 | 更新策略 | 特殊处理 |
|---|---|---|---|---|---|
| workbuddy | go-binary | `workbuddy2api.exe`（cwd=workDir，env 对齐） | `/healthz` | replace-binary | 目录含 activity.exe/credit.exe 等辅助 exe，更新时按 asset 清单整体替换或仅替换主程序（assetPattern 决定）；config.json 不覆盖 |
| codearts | go-binary | 主 exe | `/v1/models`（轻量） | replace-binary | auths/、data/ 不动 |
| loomy | python-module | `python -m loomy2api serve`（cwd=workDir） | `/health` | replace-dir（zip 解包，保留 accounts.json/config.json） | 纯标准库 → 捆绑 python-embed 3.11（约 15MB）即可免系统 Python；`start.cmd` 不再使用 |
| sub2api | go-binary | `server.exe` + 依赖编排 | `/api/health`（实测确认） | replace-dir | 启用前先 §8 依赖初始化；首次启动迁移可能耗时（其代码迁移超时 10min），UI 显示进度 |

---

## 6. Hub 轻量聚合层详细设计（Go 单二进制，零 DB）

### 6.1 hub.json

```json
{
  "listen": "127.0.0.1:17810",
  "api_key": "sk-wanneng-xxxxxxxx",
  "admin_key": "admin-xxxxxxxx",
  "upstreams": [
    { "id": "workbuddy", "base_url": "http://127.0.0.1:7863", "api_key": "<workbuddy 的 api_key>",
      "enabled": true, "priority": 1, "health_path": "/healthz", "models": ["*"] },
    { "id": "codearts", "base_url": "http://127.0.0.1:7866", "api_key": "<codearts 的 api_key>",
      "enabled": true, "priority": 2, "health_path": "/v1/models", "models": ["*"] },
    { "id": "loomy", "base_url": "http://127.0.0.1:17990", "api_key": "<loomy 的 api_key>",
      "enabled": true, "priority": 3, "health_path": "/health", "models": ["deepseek-*", "*"] }
  ],
  "model_routes": {
    "claude-*":  ["workbuddy", "codearts"],
    "deepseek-*": ["loomy"],
    "*": ["workbuddy", "codearts", "loomy"]
  },
  "cooldown": { "rate_limit_sec": 600, "rate_limit_max_sec": 3600, "server_error_sec": 30, "auth_error": "manual" },
  "catalog_cache_sec": 300,
  "usage_flush_sec": 30
}
```

### 6.2 端点与转发行为

| 端点 | 行为 |
|---|---|
| `POST /v1/chat/completions` | 按模型选上游 → 原样转发（含 SSE 流式逐帧透传） |
| `POST /v1/messages` | Anthropic 协议按同一套路由转发（三个上游均支持） |
| `GET /v1/models` | 聚合各上游 `/v1/models`（缓存 `catalog_cache_sec`），每模型打 `[平台]` 标签，去重 |
| `GET /health` | Hub 自身 + 各上游健康摘要（供壳子探活与用户探活） |
| `GET /v1/admin/usage` | admin_key 鉴权，返回用量汇总 |
| `POST /v1/admin/reload` | admin_key 鉴权，热重载 hub.json |

**鉴权**：客户端用 Hub 的 `api_key`；Hub 对上游替换为各平台自己的 key（`Authorization` 头改写）。密钥在 hub.json 中支持 `env:VAR` 形式引用环境变量，避免明文扩散。

### 6.3 选号与故障转移算法

```
1. 解析 model → 命中 model_routes 最具体的模式（精确 > 前缀通配 > *）
2. 候选 = 路由列表 ∩ enabled ∩ healthy ∩ 未冷却，按 priority 升序
3. 依序尝试：连接失败 / 5xx / 429 → 该上游进入冷却（429 指数退避 600s 起封顶），换下一个
4. 已开始向客户端输出 SSE 后不再切换（避免重复输出）；首字节前的失败可切换
5. 全部候选失败 → 返回 502 + 各上游失败摘要
6. 成功 → 记账（见 6.4），会话粘性 V1 不做（各上游已有会话关联能力，Hub 不介入）
```

### 6.4 用量记账（无 DB）

- 每请求一条记录：`{ts, upstream, model, status, ttfb_ms, latency_ms, prompt_tokens, completion_tokens}`（tokens 从响应 usage 字段提取，流式从最后 chunk 提取）。
- 内存环形缓冲（最近 10000 条）供 UI 实时查询；每 `usage_flush_sec` 追加写 `hub/usage/YYYYMMDD.jsonl`。
- 重启后：当日 JSONL 回读汇总，历史文件保留（由壳子日志策略清理 >30 天）。
- 冷却/健康状态持久化到 `hub/state.json`，Hub 重启恢复。

### 6.5 Hub 与壳子的关系

Hub 也是 platforms.json 中的一个条目（id=hub，type=go-binary），享受同一套启停/健康/日志/更新机制。壳子 UI 的「Hub」页通过 Manager API 读 Hub 的 admin 端点。

---

## 7. 远程更新机制详细设计

### 7.1 检查

```
GET https://api.github.com/repos/<repo>/releases/latest（可选带 token）
→ semver 对比当前版本（当前版本来源：平台登记时人工填写，或二进制 --version 探测，每平台适配器声明 versionCmd）
→ assetPattern 匹配下载资源
```

### 7.2 应用（replace-binary）

```
1. 下载到 updates/<id>/<version>/（带 .part 中间文件，防半包）
2. 可选 sha256 校验（release 提供时）
3. 平台状态 → updating
4. stop 平台（优雅）
5. 备份：当前二进制 → updates/<id>/backups/<ts>/
6. 覆盖新二进制；**不动 workDir 下的 config.json / auths / data**
7. start → 60s 内健康通过？
   ├─ 是：登记新版本，清理旧备份（保留 keepBackups=3），状态 → healthy
   └─ 否：恢复备份 → 重启 → 标记「更新失败已回滚」，UI 告警
8. 任何一步异常 → 平台状态恢复 stopped，.updating 残留目录在下次壳启动时清理
```

### 7.3 replace-dir（loomy / sub2api）

zip 下载 → 解包到暂存 → stop → 备份整个目录中**可执行部分**（排除 accounts.json / config.json / auths / data 等数据文件，每平台适配器声明 `preserveGlobs`）→ 覆盖 → start → 健康验证 → 同 7.2 回滚逻辑。

### 7.4 壳子自身更新

`electron-updater` + GitHub Releases（完全照搬 any-auto-register main.js:262-291 的 update-available / update-downloaded 事件流），下载完成后提示重启应用。

---

## 8. sub2api 可选模块（依赖编排）详细设计

仅在 `platforms.json` 中 sub2api.enabled=true 时生效。

### 8.1 依赖组件

| 组件 | 来源 | 部署 |
|---|---|---|
| PostgreSQL 15 | 官方 Windows zip 免安装版 → `deps/pg15/` | 首次启用：`initdb -D <data>/pgdata -U wanneng -E UTF8`；生成最小 postgresql.conf（port 5433、listen_addresses=127.0.0.1、max_connections=50） |
| Redis | `D:\sub2api-custom` 根目录已带 Memurai Developer 安装包；改用 Memurai 便携版或 zip 版 Redis for Windows → `deps/redis/` | port 6380，仅 127.0.0.1，无持久化要求时 save "" 关 RDB |

### 8.2 启动编排（PlatformManager 对 requires=["pg","redis"] 的处理）

```
start sub2api:
  1. pgdata 不存在 → initdb（UI 显示「首次初始化」）
  2. spawn postgres -D pgdata -p 5433 → 轮询 pg_isready（最长 60s）
  3. spawn redis-server --port 6380 → PING 探活（最长 30s）
  4. spawn server.exe，env 注入：
     DATABASE_URL=postgres://wanneng:<随机首次生成密码>@127.0.0.1:5433/sub2api
     REDIS_HOST=127.0.0.1, REDIS_PORT=6380
     server.port=8080（config 或 env，实测其 viper 键名）
  5. 等待 /api/health（迁移首次执行可能久，UI 超时提示放宽到 10min，与源码迁移超时一致）

stop sub2api:
  server.exe → redis → pg（pg 用 pg_ctl stop -D pgdata -m fast）
```

- PG/Redis 作为 sub2api 的**影子进程**管理：随 sub2api 启停，不单独出现在平台列表，状态显示在 sub2api 卡片内（三个小圆点）。
- 数据库密码首次启用时随机生成，写入 manager.json 的 sub2api 段。
- sub2api 自带 SQL 迁移（source of truth），壳子不干预 schema。

---

## 9. 打包与分发

| 产物 | 工具 | 内容 |
|---|---|---|
| wanneng2api-setup.exe | electron-builder（NSIS），配置参考 any-auto-register `electron-builder.yml` | 壳 + UI + hub.exe + python-embed（loomy 用） |
| 便携版 zip | electron-builder --dir | 同上，免安装 |

- GitHub Actions 构建（参考三平台各自的 CI），产物自动挂到 Release，壳子自更新走同一渠道。
- 各 2api 网关的二进制**不打包进壳**，由更新器从各自 repo 拉取——避免壳的 release 被上游协议代码污染，也保证各平台版本独立演进。
- 首次启动引导：向导式「添加平台」——选择托管新建 / 导入现有目录 / 自动探测本机已运行的 2api 服务（扫 7863/7866/17990/8080 端口）。

---

## 10. 实施计划（阶段化，验收标准驱动）

### Phase 0 — 壳骨架 + 三平台托管
- Electron 壳 + PlatformManager + platforms.json + 概览/平台管理两页
- workbuddy / codearts / loomy 三适配器跑通（托管或导入模式）
- **验收**：壳启动后三平台自动拉起且健康；UI 可启停；日志页实时可见；杀掉任一平台进程 2s 内被自动拉起

### Phase 1 — Hub 聚合层
- hub.exe 全部 §6 功能 + UI Hub 页
- **验收**：单一 `base_url + api_key` 下 Claude Code（/v1/messages）与 OpenAI SDK（/v1/chat/completions）可分别命中 workbuddy/loomy；模型目录聚合正确；手动停掉高优先级上游后请求自动落到低优先级且冷却生效

### Phase 2 — 远程更新
- §7 全流程 + 更新中心页
- **验收**：对 loomy（真实 repo 有 release）执行 check→apply 全链路；断网/坏包/健康失败三种场景均正确回滚

### Phase 3 — sub2api 可选模块
- §8 依赖编排 + 依赖打包 + UI 依赖状态显示
- **验收**：一键启用后 PG/Redis/sub2api 全链路健康；停用后三进程全部退出、端口释放；再次启用数据仍在

### Phase 4 — 打包分发与打磨
- NSIS 安装包 + 便携版 + 托盘/自启/自更新 + 添加平台向导
- **验收**：干净 Windows 机器双击安装 → 引导添加 → 全部功能可用

依赖关系：0 → 1 → 2 → 3 → 4（1 和 2 理论可并行，但更新器要更新 hub，建议串行）。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 各平台主 exe 文件名/健康端点未逐一实测 | 实现前逐平台验证，写入适配器规格（§5 为待核对清单） |
| loomy 用户现有 accounts.json 含 9 个 .bak，数据敏感 | 默认 import 模式；壳子对导入目录只追加日志/备份；更新器 preserveGlobs 保护 |
| sub2api 首次迁移耗时长 | UI 明示「首次启动需数分钟」，健康等待上限 10min 与其源码一致 |
| 端口被第三方占用 | spawn 前预检 + 卡片红色告警，不盲目重启循环 |
| 代理环境变量污染上游连接 | 全部平台 env 强制 `NO_PROXY=*`（照搬 AAR backendEnv） |
| GitHub API rate limit | 可选配置 token；无 token 时限频（每次启动检查一次） |
| 中文路径（D:\软件\…） | 全链路统一正斜杠 + 加引号；实测导入模式指向中文目录 |
| 壳子崩溃留下孤儿进程 | 托盘退出走反序 stop；异常退出后下次启动先探测已运行实例并收养（adopt：直接标记 healthy 而不重复 spawn） |

---

## 12. 明确不做（Scope 边界）

- 不做用户体系/计费/多租户（那是 sub2api 的职责，按需启用即可）
- 不做壳子层协议翻译（上游已做，Hub 只路由）
- 不改动三个现有网关的代码与配置格式
- 不做 PG→SQLite 移植（决策 D1）
- 不做 Linux/macOS 适配（首期 Windows；技术选型天然可移植，后按需加）
