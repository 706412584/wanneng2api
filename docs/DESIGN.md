# Wanneng2API — 统一网关平台完整设计方案

> 定位：把现有的多个 2api 网关（workbuddy2api / codearts2api-panel / loomy2api / 可选 sub2api）统一到一个**桌面壳 + 平台管理 + 轻量聚合层**的平台上。
> 壳子参考 `D:\软件\any-auto-register`（Electron spawn 后端模式），底层可选接入 `D:\sub2api-custom`。
> 本文档是项目的权威设计文档，实现以其为准。

---

## 0. 结论先行（关键决策记录）

> 2026-11-14 实施补充：新用户首次运行使用 `<数据目录>/platforms/<id>`，四网关可从各自公开 Release 一键安装；已有 `platforms.json` 的导入目录、配置和账号不自动迁移。安装状态、下载进度、健康验证与 magpie 注册由 Manager API 提供。空账号池只要求进程监听成功，不把 `/healthz 503` 误判为安装失败。壳自更新在更新中心展示下载进度，只有用户再次点击「重启并安装」才退出。下文 §6 自研 Hub 为历史设计，当前统一入口仍是 magpie :3425。

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
│  · React UI 七页：概览 / 平台管理 / 更新中心 / Hub / 外网访问 / 日志 / 设置 │
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
| **17901-17906** | 外网安全入口（仅 127.0.0.1；依次对应四网关、magpie、管理台） | 新增 |
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
├── tunnels.json                 # 外网目标公共配置（Quick/Named、autoStart、入口端口）
├── private\
│   └── tunnel-secrets.json      # Named Token 与管理台 scrypt 密码记录（API 不回显）
├── bin\cloudflared\             # 固定版本、经 SHA-256 验证的连接器缓存
├── logs\
│   ├── tunnels\<id>.log         # 各目标脱敏隧道日志（复用轮转策略）
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
| 外网访问 | cloudflared 安装状态、六目标折叠卡片；Quick/Named、autoStart、预检、启停、Service URL 与日志均在配置/日志弹窗中操作 |
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

> **历史方案，未采用。** 当前没有 `hub/` 实现；统一协议、路由、quota 由 magpie 承担。以下仅保留决策演进记录，新增功能不要按本节自研 Hub。

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

`electron-updater` + GitHub Releases。`shell/src/self-updater.js` 统一维护 `idle / checking / available / downloading / downloaded / error` 状态，更新中心展示真实下载百分比和字节数。检查、下载以及下载完成均不自动退出；用户点击「重启并安装」后才停止平台并调用 `quitAndInstall()`。

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

---

## 13. 统一外网访问模块（2026-11-15 实现）

### 13.1 范围与边界

`shell/src/tunnel/` 是独立的 Cloudflare Tunnel 管理模块，覆盖 workbuddy / codearts / loomy / lingxi / magpie / manager 六类目标，每目标支持 Quick 与 Named、autoStart、预检、启停、健康和日志。首版不做 Pinggy、FRP、P2P、Tailscale，也不自动创建 Cloudflare Tunnel、DNS 或 ingress。

- 不调用 LAN 开关，不修改原网关监听地址，不隐式启动/重启平台。
- 每目标独立受限 loopback 网关和 cloudflared 进程，默认入口依次为 17901-17906；Named 每目标独立 Token 与 Public Hostname。
- Quick 使用 `--url http://127.0.0.1:<guardPort>` 并解析临时地址；Named Token 仅经 `TUNNEL_TOKEN` 环境传递，不进入 argv。
- cloudflared 固定为 2026.10.6，官方资产按平台 SHA-256 校验；缓存校验失败不得执行，多目标共享整个校验/安装 singleflight。
- 只有连接器注册成功且公网固定健康端点验证通过，状态才进入 running；崩溃和连续公网失败按退避重连。旧进程未确认停止时严禁创建新实例。

### 13.2 API 目标安全

`target-adapters.js` 按各网关源码固化普通 API Key、环境变量优先级和 path/method 白名单；`public-api-gateway.js` 每次请求重新按 mtime 读取有效 Key，常量时间比较，并流式转发允许的模型请求。

- CodeArts `admin_key` 不属于公开 API Key；magpie 读取 `caller-keys.json` 中启用且未过期的 Gateway Key。
- 不接受 query 传 Key，外部客户端仍使用原服务普通 API Key；密钥不注入、不自动生成、不改写。
- 管理面板、账号、配置、日志、签到、用量管理和 Upgrade 默认拒绝；拒绝二次编码与点段，清理伪造转发头。
- 无法证明目标鉴权与路由安全时 preflight 阻断，不能退化为无鉴权开放。

### 13.3 远程管理台安全

Manager 隧道指向 `remote-gateway.js`，绝不直接指向 17800。固定单管理员、至少 12 位密码，scrypt 哈希落私有配置；登录包含全局/IP 失败限流及进行中 scrypt 并发上限。

- 随机会话只存内存，服务端保存 SHA-256 索引，12 小时过期；Cookie 为 `__Host-`、`HttpOnly; Secure; SameSite=Strict; Path=/`。
- 每会话独立 CSRF secret，写请求校验会话、CSRF、公网 Origin 和 Host；响应统一 `frame-ancestors 'none'` 与 `X-Frame-Options: DENY`。
- 认证后静态 UI、Manager API 和本机 SSE 才允许流式代理；内部请求规范化为本机 Host/Origin，不转发远程 Cookie/CSRF。实网验证发现部分 Cloudflare Quick 链路只返回响应头、不转发 SSE 数据帧，因此远程日志在会话中自动使用 2 秒去重轮询，桌面本机仍使用 SSE。
- 注销、停止入口与修改密码撤销会话；Manager 非 loopback 或 UI 未挂载时禁止启动。

### 13.4 配置、日志与生命周期

公共配置 `<dataDir>/tunnels.json`；秘密配置 `<dataDir>/private/tunnel-secrets.json`，原子写入、损坏 fail closed、API 只返回 hasToken/passwordConfigured。日志复用 RingBuffer + RotatingFileWriter，Token、API Key、Cookie、Authorization 与代理凭据在落盘前脱敏。

Electron、纯 Web、自更新退出均按 `TunnelManager.stopAll()` → `PlatformManager.stopAll()` → `ApiServer.close()` 清理。autoStart 只恢复隧道，不启动目标平台；本机健康探测固定直连，不经过 tunnelRuntime 代理。

UI 为独立「外网访问」页。六张卡片默认折叠、统一 270px；卡片只展示状态、公网地址与操作，配置及日志使用带焦点锁/滚动锁的独立弹窗，未保存配置关闭时确认，密码输入关闭即清空。

### 13.5 验证边界

`npm --prefix shell run test:tunnels` 覆盖存储、固定资产与断流、Quick/Named 进程、API 白名单、远程认证和六目标状态机，全部使用临时目录、fake cloudflared 与 loopback mock。真实 Quick/Named 公网地址只有用户另行确认后才创建，不作为默认测试或启动动作。

### 13.6 Named Token 前置验证（2026-11-16 补充）

Named 配置顺序为 Token → 验证 → Public Hostname。`parseNamedTokenInfo()` 仅校验 base64url JSON 的 `a/t/s` 和 tunnelId，真正验证由独立临时 cloudflared 完成：收到 `Registered tunnel connection` 后先确认进程停止，再把候选 Token、verifiedAt、tunnelId 和 fingerprint 原子写入同一个私有 `tunnel-secrets.json`。

`POST /api/tunnels/:id/verify-token` 不要求 publicUrl，不启动 guard gateway 或公网健康检查。验证进程与正式进程互斥并纳入 stopAll；验证期间配置变化、重复验证、停止失败和旧代次结果均不得保存。Token 修改或清除会删除对应验证记录。

Named `startConfig()` 同时要求 publicUrl、verifiedAt/tunnelId 匹配和 fingerprint 匹配，未验证返回 `TOKEN_VERIFICATION_REQUIRED`，不进行自动重试。现有运行实例不停止，但下次启动前需完成一次验证。UI 在验证通过前禁用 Public Hostname，草稿 Token 变化立即恢复未验证状态。

### 13.7 模型 aliases 与 Hub 自定义组删除（2026-11-16 补充）

公网使用的独立 Gateway Key 采用 magpie 原生 aliases：裸模型名在目录中原位显示，请求在路由和权限判断前还原为 `wanneng-lingxi/<真实模型>`。aliases 不扩大权限，不修改 `public-api-gateway`，也不把裸名加入 `Models`。配置时保留已有映射并备份 caller-keys，单次写入完整 aliases，防止覆盖。

Hub 管理视图使用 `RoutingGroups.manageable()` 返回全部自定义组和多成员 auto 组，修复单成员绑定不可见；`shared()` 仍保留给原模型目录聚合。`remove(id)` 按精确 id 重新读取目标，`auto:true` 或不存在均拒绝，只有非 auto 自定义组才调用内核 `groups/delete`。

前端仅对非 auto 组显示删除按钮，按钮不嵌套在组标题按钮内。确认文案明确“删除自定义路由组，不删除 provider、账号或模型”，并提示控制台手建组也可删除。请求代次防止删除前的旧响应覆盖新列表。测试桩 save 使用 upsert、delete 真实过滤 state.groups，覆盖自动组零调用、单成员可见、重复/缺失 id 和 provider 不变。

### 13.8 通用 aliases 自动同步与灵犀硬冷却（2026-11-16 补充）

`magpie-alias-sync.js` 以 magpie 原生 providers/groups/caller-keys 为唯一边界，覆盖四家自建、本地 custom 和社区/内置插件 provider，不逐插件编写适配器，也不改 `public-api-gateway` 的透明转发与鉴权范围。外网页的默认折叠卡片只选择“aliases 同步目标 Key”，不默认第一把、不自动创建 Key；provider 首次必须逐个明确授权，之后自动跟随启用模型。前端只能提交 `select-key/provider-set/sync`，不能提交 Models、Aliases、target、members 或通配符。

`alias-sync.json` 只保存目标 Key ID、授权 provider、上次实际托管项、模型缓存、pendingWrite、suppression 和冲突，不保存任何 secret。状态文件损坏时禁止写入；caller-keys 只读安全字段，写操作使用原生 `models-key/aliases-key/off-key/on-key`，不直接修改 `caller-keys.json`。Models 与 Aliases 分步写入并回读，实际进度只合并到磁盘最新状态，singleflight + revision 保证写入途中撤销不会复活旧授权；select-key/provider-set 另有独立 mutation queue，等待 provider 快照后重新读取状态再修改。pendingWrite 只在回读值与待写值一致时补记托管进度，缺失项允许重试。外部删除以带 provider 归属的 suppression 持久化，后续 reconciliation 不得加回，只有重新明确授权该 provider 才解除。模型刷新后重新读取目标 Key，每次全量写前再比较 Models/Aliases 快照，发现外部漂移就放弃本轮，不能把旧计划覆盖到用户新配置上。

四家自建 provider 的模型刷新与本机 Gateway 目录、外网 aliases 授权**完全解耦**：壳启动、平台恢复健康以及 10 分钟周期都会调用原生 `provider/models`，因此本地 `127.0.0.1:17899` 的 Gateway 页面同样能看到上游新增模型（如 `kimi-k3.1-pro`）。仅刷新模型不写 caller-key；未注册的 provider 跳过，不算刷新失败；控制台不可用时保留缓存。

只调用 `provider/models` 并不够：magpie 的 `Refetch` 会把新模型追加进 picks，但**不会移除已下架的旧 picks**（首次 Refetch 前 catalog 为空时 `dropGonePicks` 直接跳过）。因此在刷新后，壳还会通过 `GatewayPanel.models(id)` 读取各网关的**真实模型列表**，与 `providers.json` 中该 provider 的实际 picks 比较；不一致时调用原生 `provider/save`，只写 `models` 和必要的高级字段（`provider/save` 要求至少一个 base URL，缺失会报 “a provider needs a base URL”）。这样旧 GPT 会从目录移除、`kimi-k3.1-pro` 会出现，且已一致时不会重复写入。该收敛只针对四家自建 provider，不触碰社区插件与 Gateway Key 权限。已授权的本地/社区 provider 在同一轮内按缓存周期跟随刷新，60 秒 reconciliation 只核对本地状态。刷新失败使用缓存并报告，空目录未知与明确 `noModels`/全 off 严格区分。这修复了“灵犀真实 11 模型，但 magpie/公网长期保留旧 27 模型和 7 个 GPT”的旧快照问题，不能在代理层按模型名硬过滤。

唯一裸名指向 direct ref；同名裸名只可使用唯一、静态、无动态成员、keys 允许当前 Key 且成员集合与已授权同名模型精确相等的现有路由组。auto 组使用原始公开 ref，自定义组使用 `group/<id>`。任何冲突都不得回退第一家，同步器不写 `groups/save`。首次授权可接管该 provider 的 direct aliases、精确模型和 `provider/*`；无关手工项与 Accounts 保留，外部修改不反复覆盖。Aliases 最多 200、Models 最多 500，超限零写入。

Models 空数组可能表示“不限制”，因此不能用来撤销。仍有手工 Models 时只移除托管项；没有手工 Models、手工 aliases 和 Accounts 限制且曾存在托管项时，最后撤销才通过 `off-key` 禁用目标 Key，旧 Models/Aliases 保留以便后续收敛。存在手工 aliases 或 Accounts 而 Models 将变空时记录冲突并要求人工处理，不写空 Models，也不禁用 Key。只有 `disabledBySync` 的 Key 才能在恢复非空计划后自动 `on-key`。初始配置即冲突且没有托管项时只报错，不直接禁用 Key。

四家普通 API Key 自动从本机 env/config 同步：已有 provider 使用 `provider key` 且值一致时零写入，缺失只能由安装或手动注册 `provider add`，读取损坏不得误判缺失。CodeArts `admin_key` 永不作为普通 Key。社区/本地插件凭证不读取、不复制。

灵犀 `Pool.Revive` 补齐清理 `degradeUntil/consecutiveFails`，并经既有 dirty/Flush 持久化。连败降权为严格硬冷却：未到期不参与 weighted-random 全冷却兜底，旧在途 `NoteSuccess` 只清计数、不提前解除截止；到期惰性恢复，人工 Revive 可立即恢复。阈值、错误归因和权重不在本轮改动。壳适配层展示降权状态并提供显式解冻；恢复选号必须显式发送 `paused:false`。源码修复不自动替换或重启当前灵犀服务，需另行授权部署。

验证使用 `test-magpie-alias-sync.js` 的临时目录与原生 API 桩，覆盖旧 27→真实 11、首次接管、手工项保留、组冲突、外部修改、上限、最后撤销、部分完成和写入途中撤销；`test-platform-install.js` 固定使用不存在的 magpie 路径，禁止测试误写真实 provider。灵犀 pool/全量 Go 测试覆盖并发硬冷却、旧成功不解封和 Revive 持久化。真实公网修复与灵犀部署必须另行确认。

### 13.9 Gateway Key 额度（2026-11-16 补充）

magpie 原生 `Limit` 已支持 `period: day|week|month|days|hours|total`，`days` 为 1–3650、`hours` 为 1–8760，每把 Key 最多 5 条额度，可按模型限定统计范围。原生 Gateway 页面的“额度”对话框只暴露日/周/月，因此壳在 Hub 增加「网关密钥」页补齐每 N 天/每 N 小时入口。

`GET /api/magpie/gateway-keys` 只投影安全字段：`id/name/off/readOnly/browser/expires/models/limit/more/used/usedAll`，绝不返回 `secret`、`masked` 或账号。`POST /api/magpie/gateway-keys/limit` 与 `reset-limit` 做白名单校验（Key ID 格式、周期、天数/小时范围、Token/费用非负且至少一项、模型最多 50 个、序号 0–4），再调用原生 `caller-keys/limit-key` / `reset-limit-key`；不直接改写 `caller-keys.json`。费用字段仍是 magpie 的估算美元（`cost`），不是供应商账单。

### 13.10 睡眠与唤醒恢复（2026-11-16 补充）

壳不启用 `powerSaveBlocker`，不阻止系统睡眠。S3/S4 期间壳、四家网关和 cloudflared 均被冻结，网络会话失效，外网隧道必然中断；进程通常不会被杀，但已有 TCP/TLS 连接基本失效。

`main.js` 监听 `powerMonitor` 的 `resume`（5 秒去抖，锁屏不处理），延迟 3 秒后调用 `PlatformManager.handleResume()` 与 `TunnelManager.handleResume()`：只重置健康失败计数、清掉旧健康定时器并延迟重新探测，**不主动 spawn/start**。进程已退出仍走既有 exit 重启/退避；`reconnecting` 状态保留原重连路径。这样避免唤醒瞬间网络未就绪被误判为“隧道已死”而重启，Quick 隧道也不会因此换 URL。`handleResume` 可用 `delayMs` 注入，测试用 fake 进程验证“唤醒不重启、只重置计数”。

必须实机验证的部分：本机实际睡眠状态（`powercfg /a`）、唤醒后网络恢复耗时、cloudflared 同进程重连是否保留 Quick URL、四家网关上游连接是否恢复（本地 `/healthz` 可能仍 200）。睡眠/唤醒行为不承诺“服务持续运行”。

### 13.11 隧道启动失败持续重连（2026-11-17 补充）

旧逻辑在 `_handleStartError` 中要求 `runtime.wasRunning || runtime.restoring` 才重连，网络中断时 cloudflared 可能从未成功注册（`START_TIMEOUT`），或某次重连失败后 `wasRunning` 为 false，于是隧道停在 `error` 直到用户手动重启。现象是日志里最后一次失败后长时间没有新的 `Starting tunnel`。

现在只要 `desiredRunning` 为真且错误不在 `FATAL_CODES`（配置、Token、鉴权、端口冲突等）中，就持续按指数退避重连（2 秒起，封顶 60 秒）；网络恢复后自动上线。设置页可开启“防止系统休眠”：使用 `powerSaveBlocker.start('prevent-app-suspension')`，只设 `ES_SYSTEM_REQUIRED`，不设 `ES_DISPLAY_REQUIRED`，因此屏幕仍会按电源计划息屏；退出或关闭开关时释放。它不能可靠阻止主动睡眠/合盖。`START_TIMEOUT`、`TARGET_UNAVAILABLE`、`PUBLIC_HEALTH_FAILED`、`PROCESS_EXIT` 都可重试。清理旧实例失败（`STOP_UNCONFIRMED`）仍会停止并阻断新实例，避免双实例。

断网可能持续数分钟。为避免每次重试都拉起 cloudflared 再等 30 秒启动超时，重连定时器到点后先做轻量网络探测（`defaultNetworkProbe`：TCP 连接 `api.cloudflare.com:443`，3 秒超时，可注入，探测 socket/timer 均 unref，停止时用 AbortSignal 取消）。启用 `tunnelRuntime` 代理时探测必须经同一代理（HTTP/SOCKS agent），否则直连被本地策略挡住、cloudflared 却能经代理上线时会被永久判离线。未就绪时不 spawn，只每 `networkWaitMs`（默认 10 秒）重新探测，并且只记一条“网络尚未恢复”日志；一旦探测通过，重置 `retryAttempt` 并立即重连。只有从“网络不可用”恢复时才清零退避，普通重连继续指数增长（否则 `PROCESS_EXIT`/`PUBLIC_HEALTH_FAILED` 会永远停在 2 秒间隔）。代理链路下连续两次探测失败后不再让探测否决重连，直接交给 cloudflared 按代理实际尝试。测试通过注入 `networkProbe` 验证断网期间进程数不增长、恢复后自动上线、连续失败保留退避，以及代理模式下两次失败后跳过预检重连。
