# Wanneng2API Shell — Manager API 手动验证（selftest）

Manager API 内嵌 Electron 主进程，仅绑定 `127.0.0.1:17800`。
壳未启动时以下命令不可用；先 `cd shell && pnpm install && pnpm start`。

自动化测试（不依赖 Electron）：

```bash
node scripts/test-platform-manager.js   # 状态机/自动重启/端口预检/日志（24 项）
node scripts/test-api-server.js         # Manager API 全端点（34 项）
node scripts/test-orchestration.js      # sub2api 依赖编排（20 项）
```

以下 curl 验证假设默认 platforms.json（workbuddy/codearts/loomy/hub 启用）。

## 1. 基础读取

```bash
# 概览：平台状态汇总 + hub 卡片
curl -s http://127.0.0.1:17800/api/overview | python -m json.tool

# 平台列表
curl -s http://127.0.0.1:17800/api/platforms | python -m json.tool

# 单平台详情（配置摘要 + 重启次数 + 最近错误）
curl -s http://127.0.0.1:17800/api/platforms/workbuddy/detail

# 最近 50 行日志
curl -s "http://127.0.0.1:17800/api/platforms/loomy/logs?tail=50"

# SSE 实时日志（Ctrl+C 退出；启停平台应看到新行推入）
curl -N http://127.0.0.1:17800/api/platforms/codearts/logs/stream
```

## 2. 启停与重启

```bash
curl -X POST http://127.0.0.1:17800/api/platforms/workbuddy/start
curl -X POST http://127.0.0.1:17800/api/platforms/workbuddy/restart
curl -X POST http://127.0.0.1:17800/api/platforms/workbuddy/stop

# 禁用（若在运行会同时停止）→ 启用
curl -X POST http://127.0.0.1:17800/api/platforms/loomy/disable
curl -X POST http://127.0.0.1:17800/api/platforms/loomy/enable

# 验收点：start 后任务管理器杀掉 server.exe，≤2s+backoff 内应自动拉起，
# 且 /api/platforms/workbuddy/detail 的 restartAttempts 递增。
```

## 3. 更新

```bash
# 检查（loomy 配有真实 repo Patrick130306/loomy2api）
curl -X POST http://127.0.0.1:17800/api/platforms/loomy/update/check

# 应用更新（会 stop → 备份 → 覆盖 → start → 60s 健康验证；失败自动回滚）
curl -X POST http://127.0.0.1:17800/api/platforms/loomy/update/apply

# 全平台版本汇总（更新中心页数据源）
curl -s http://127.0.0.1:17800/api/updates/summary
```

## 4. Hub / 设置 / 面板

```bash
# Hub 状态（hub 未注册时返回 unknown）
curl -s http://127.0.0.1:17800/api/hub/status

# 热重载 hub.json（无独立 reload 端点时退化为重启 hub 平台）
curl -X POST http://127.0.0.1:17800/api/hub/reload

# 读写设置（PUT 为浅合并，未提交键保留）
curl -s http://127.0.0.1:17800/api/settings
curl -X PUT -H "Content-Type: application/json" \
  -d '{"general":{"closeAction":"quit"}}' \
  http://127.0.0.1:17800/api/settings

# 打开系统浏览器访问平台面板
curl -X POST http://127.0.0.1:17800/api/platforms/codearts/open-panel
```

## 5. CORS 验证

```bash
# file:// 页面（Origin: null）→ 放行，回显 Access-Control-Allow-Origin: null
curl -i -H "Origin: null" http://127.0.0.1:17800/api/overview

# 127.0.0.1 来源（UI dev server）→ 放行
curl -i -H "Origin: http://127.0.0.1:5173" http://127.0.0.1:17800/api/overview

# 外域 → 403
curl -i -H "Origin: http://evil.example.com" http://127.0.0.1:17800/api/overview
```

## 6. sub2api（默认关闭；启用前需部署 deps）

```bash
# 先部署便携 PG15 → %AppData%/wanneng2api/deps/pg15（bin/pg_ctl.exe 等）
# 部署 Redis → %AppData%/wanneng2api/deps/redis（redis-server.exe）
curl -X POST http://127.0.0.1:17800/api/platforms/sub2api/enable
curl -X POST http://127.0.0.1:17800/api/platforms/sub2api/start
# 观察编排：initdb → postgres(:5433) → pg_isready → redis(:6380) → server.exe(:8080)
curl -s http://127.0.0.1:17800/api/platforms/sub2api/detail | python -m json.tool  # deps 三圆点
curl -X POST http://127.0.0.1:17800/api/platforms/sub2api/stop   # 反序: server → redis → pg
```

## 7. 日志位置

```
%AppData%/wanneng2api/logs/manager.log          # 壳自身
%AppData%/wanneng2api/logs/platforms/<id>.log   # 各平台 stdout/stderr（10MB 轮转留 5 份）
```
