// 系统提示词改写 middleware：用网关自有提示词替换客户端注入的 system/developer 消息。
//
// 背景：Claude Code / Codex CLI 在 system prompt 注入固定模板句，上游内容审核
// 按逐字精确匹配误杀合法流量。换掉整段 system 就从源头消灭了这类误报。
//
// 移植自 workbuddy2api 的 internal/prompt/prompt.go（同源定制）。
//
// 与 fingerprint-sanitize 的分工：
//   - prompt-guard：替换整个 system 段（源头）；
//   - fingerprint-sanitize：清洗 user/assistant 消息里残留的指纹串（兜底）。
// 两层叠加，互不替代。
//
// 配置：
//   {"mode": "custom", "prompt": "", "promptFile": "", "targets": ["system", "developer"]}
//   mode=custom    → 用 prompt / promptFile / 内置默认提示词替换
//   mode=passthrough → 不动 system，只留指纹脱敏给另一个 middleware
//   mode=remove    → 直接删除 system 段（不插入替代提示词）

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))

// 降级提示词：误报处理用，刻意极简中性。
const DEGRADED =
  "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise."

let builtinPrompt = null
function builtin() {
  if (builtinPrompt === null) {
    try {
      builtinPrompt = readFileSync(join(HERE, "default-prompt.md"), "utf8").trim()
    } catch {
      builtinPrompt = DEGRADED
    }
  }
  return builtinPrompt
}

function resolvePrompt(o) {
  if (typeof o.prompt === "string" && o.prompt.trim()) return o.prompt
  if (typeof o.promptFile === "string" && o.promptFile.trim()) {
    try {
      return readFileSync(o.promptFile, "utf8").trim()
    } catch {
      // 配置的文件读不到 → 退回内置，不因配置错误阻塞所有请求
    }
  }
  return builtin()
}

// ── 各协议的 system 位置 ──────────────────────────────────────────────
// Chat Completions / Anthropic：messages 里的 system / developer 消息
//                             + Anthropic 顶层 system 字段
// Responses：instructions + input 里的 system / developer 项
// Gemini：systemInstruction / system_instruction

function isSystemRole(role) {
  return role === "system" || role === "developer"
}

// Chat + Anthropic 共用：处理 messages 数组，按 mode 替换或删除。
function rewriteMessages(messages, text, mode) {
  if (!Array.isArray(messages)) return false
  const kept = []
  let changed = false
  for (const m of messages) {
    if (m && typeof m === "object" && isSystemRole(m.role)) {
      changed = true
      continue
    }
    kept.push(m)
  }
  if (!changed) return false
  if (mode === "custom" && text) {
    messages.length = 0
    messages.push({ role: "system", content: text })
    for (const m of kept) messages.push(m)
  } else {
    messages.length = 0
    for (const m of kept) messages.push(m)
  }
  return true
}

// Responses API 的系统提示词规范位置是顶层 instructions，
// 因此这里只删除 input 里的 system 项，不重新插入（避免与 instructions 重复）。
function rewriteResponsesInput(input) {
  if (!Array.isArray(input)) return false
  const kept = []
  let changed = false
  for (const item of input) {
    if (item && typeof item === "object" && isSystemRole(item.role)) {
      changed = true
      continue
    }
    kept.push(item)
  }
  if (!changed) return false
  input.length = 0
  for (const item of kept) input.push(item)
  return true
}

export function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object") return
    const o = ctx && ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    const mode = o.mode === "passthrough" || o.mode === "remove" ? o.mode : "custom"
    if (mode === "passthrough") return
    const text = mode === "custom" ? resolvePrompt(o) : ""
    if (mode === "custom" && !text) return

    let changed = false

    // Anthropic 顶层 system（字符串或多模态块）
    if (body.system !== undefined) {
      delete body.system
      changed = true
      if (mode === "custom") {
        // Anthropic 允许顶层 system 为字符串；放在 messages 头部会改变角色语义，
        // 因此这里保留顶层字段形态。
        body.system = text
      }
    }

    // Responses 的 instructions
    if (body.instructions !== undefined) {
      delete body.instructions
      changed = true
      if (mode === "custom") body.instructions = text
    }

    // Gemini 的 systemInstruction
    for (const key of ["systemInstruction", "system_instruction"]) {
      if (body[key] !== undefined) {
        delete body[key]
        changed = true
        if (mode === "custom") {
          body[key] = { parts: [{ text }] }
        }
      }
    }

    if (rewriteMessages(body.messages, text, mode)) changed = true
    if (rewriteResponsesInput(body.input)) changed = true

    return changed ? body : undefined
  } catch {
    // fail open：改写失败不阻塞请求
  }
}