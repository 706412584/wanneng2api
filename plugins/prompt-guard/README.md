# prompt-guard

系统提示词改写 middleware。用网关自有提示词替换客户端注入的 system 段，从源头消灭上游"按 client 模板句逐字拦截"的误报。

移植自 `workbuddy2api` 的 `internal/prompt/prompt.go`。

## 为什么需要

Claude Code / Codex CLI 在 system prompt 注入固定模板。部分上游按逐字精确匹配拦截，导致合法请求被误判。改写整个 system 段就从源头消除了这类指纹。

## 与 fingerprint-sanitize 的分工

| middleware | 作用范围 |
|---|---|
| `prompt-guard` | 整个 system 段（源头） |
| `fingerprint-sanitize` | user/assistant/tool 消息里残留的指纹串（兜底） |

两层叠加，互不替代。两者可以同时启用。

## 模式

| mode | 行为 |
|---|---|
| `custom`（默认） | 用 `prompt` / `promptFile` / 内置默认提示词替换所有 system 段 |
| `passthrough` | 完全不动 system（只让 fingerprint-sanitize 生效） |
| `remove` | 删除 system 段，不插入替代提示词 |

## 支持的协议位置

| 协议 | system 在哪里 |
|---|---|
| Anthropic | 顶层 `system`（字符串或块）+ messages 里的 `system`/`developer` |
| Chat Completions | messages 里的 `system`/`developer` |
| Responses | `instructions` + `input` 里的 `system`/`developer` 项 |
| Gemini | `systemInstruction` / `system_instruction` |

## 配置

```json
{
  "mode": "custom",
  "prompt": "",
  "promptFile": "",
  "targets": ["system", "developer"]
}
```

- `prompt` 非空 → 用它
- `promptFile` 非空 → 读该文件（读不到时退回内置）
- 都为空的 `custom` 模式 → 用包内 `default-prompt.md`

## 失败行为

任何异常都 **fail open**：请求原样放行。

## 安装

```
magpie plugin add <本目录路径>
```