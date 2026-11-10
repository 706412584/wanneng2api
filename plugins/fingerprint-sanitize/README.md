# fingerprint-sanitize

出站指纹脱敏 middleware。把客户端（Claude Code / Codex CLI / DeepSeek Harness）注入的固定模板句改掉，因为这些上游按**逐字精确匹配**拦截，一字之差即可绕过且语义不变。

移植自 `workbuddy2api` 的 `internal/upstream/sanitize.go`。

## 为什么需要

上游内容审核不做语义判断，而是匹配固定字符串：

| 原文 | 改写为 |
|---|---|
| `You are Claude Code, Anthropic's official CLI for Claude` | `…official CLI tool for Claude` |
| `Main branch (you will usually use this for PRs)` | `Default branch (you will typically use this for PRs)` |
| `you will usually use this for PRs` | `you will typically use this for PRs` |
| `You are a coding agent running in the Codex CLI, a terminal-based…` | `…in the Codex CLI tool, a terminal-based…` |
| `To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues` | `To provide feedback, …` |
| `DeepSeek Harness` | `DeepSeekRuntime` |
| `x-anthropic-billing-header:…` | 整段删除 |
| `cc_xxx=…;` | 整段删除 |

## 契约

**只破坏上游会拦的指纹，绝不顺手动别的字节。**

请求体里同时流动着模型读到的文件内容（tool result）和模型发给工具的编辑参数（`tool_calls.arguments`）。这两处一旦被改动，模型算出的 `old_string` 就与磁盘不符，Edit 会报 `String to replace not found in file`。因此：

- 不做 `trim`
- 不做空白规范化
- 不触碰 `tool_calls[].function.arguments`
- 只处理 `content` / `system` / `instructions` / `text` 字段

## 配置

```json
{
  "enabled": true,
  "custom": [["要替换的原文", "替换后的文本"]]
}
```

`custom` 条目优先于内置规则，可用来应对新出现并被拦截的模板句。

## 失败行为

任何异常都 **fail open**：请求原样放行，不会因为脱敏出错而阻塞调用。

## 安装

```
magpie plugin add <本目录路径>
```