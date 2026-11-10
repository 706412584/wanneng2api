// 两个 middleware 的行为测试。运行：node middleware.test.mjs
import { onRequest as sanitize } from "../fingerprint-sanitize/fingerprint-sanitize.middleware.js"
import { onRequest as promptGuard } from "../prompt-guard/prompt-guard.middleware.js"

let pass = 0
let fail = 0

function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? "\n        " + extra : ""}`)
  }
}

function ctx(options) {
  return { options: options || {}, protocol: "chat", reject: () => {} }
}

console.log("\n=== fingerprint-sanitize ===")

// 1. 身份句替换，语义保持
{
  const body = {
    messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Help." }],
  }
  const out = sanitize(body, ctx())
  check("身份句被改写", out && out.messages[0].content.includes("official CLI tool for Claude"))
  check("原句不再出现", !out.messages[0].content.includes("official CLI for Claude"))
  check("其余内容保留", out.messages[0].content.endsWith("Help."))
}

// 2. 多模态 content 数组只改 text part
{
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Main branch (you will usually use this for PRs)" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ],
  }
  const out = sanitize(body, ctx())
  check("数组中的 text 被改写", out.messages[0].content[0].text.includes("Default branch"))
  check("image part 未动", out.messages[0].content[1].image_url.url === "data:image/png;base64,AAA")
}

// 3. 无指纹 → 返回 undefined（不改动）
{
  const body = { messages: [{ role: "user", content: "写一个快排" }] }
  check("无指纹时返回 undefined", sanitize(body, ctx()) === undefined)
}

// 4. header 键值剥离
{
  const body = { messages: [{ role: "system", content: "x-anthropic-billing-header: abc123; keep this" }] }
  const out = sanitize(body, ctx())
  check("billing-header 被剥离", out && !out.messages[0].content.includes("x-anthropic-billing-header"))
  check("周围正文保留", out.messages[0].content.includes("keep this"))
}

// 5. cc_ 裸键值剥离
{
  const body = { messages: [{ role: "system", content: "cc_version=1.0; cc_entrypoint=cli; real text" }] }
  const out = sanitize(body, ctx())
  check("cc_ 键值被剥离", out && !out.messages[0].content.includes("cc_entrypoint="))
  check("正文保留", out.messages[0].content.includes("real text"))
}

// 6. tool_calls.arguments 绝不改动（关键契约）
{
  const args = JSON.stringify({ old_string: "cc_entrypoint=cli;", new_string: "x" })
  const body = {
    messages: [
      { role: "assistant", tool_calls: [{ function: { name: "Edit", arguments: args } }] },
      { role: "system", content: "cc_entrypoint=cli; drop me" },
    ],
  }
  const out = sanitize(body, ctx())
  check("tool_calls.arguments 原样保留", out.messages[0].tool_calls[0].function.arguments === args)
  check("system 中的 cc_ 仍被清理", !out.messages[1].content.includes("cc_entrypoint="))
}

// 6b. 仅有 cc_version 时不触发（与 Go 原实现的特征表一致，避免误伤）
{
  const body = { messages: [{ role: "system", content: "cc_version=1.0; keep me" }] }
  check("仅 cc_version 不触发净化", sanitize(body, ctx()) === undefined)
}

// 7. custom 规则生效
{
  const body = { messages: [{ role: "system", content: "BLOCKED_PHRASE here" }] }
  const out = sanitize(body, ctx({ custom: [["BLOCKED_PHRASE", "SAFE_PHRASE"]] }))
  check("custom 规则生效", out && out.messages[0].content.includes("SAFE_PHRASE"))
}

// 8. enabled:false 关闭
{
  const body = { messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude" }] }
  check("enabled:false 时不改写", sanitize(body, ctx({ enabled: false })) === undefined)
}

// 9. 畸形输入不抛异常
{
  let threw = false
  try {
    sanitize(null, ctx())
    sanitize({}, ctx())
    sanitize({ messages: "not-an-array" }, ctx())
  } catch {
    threw = true
  }
  check("畸形输入不抛异常", !threw)
}

console.log("\n=== prompt-guard ===")

// 10. Chat：替换并前置单条 system
{
  const body = {
    model: "x",
    messages: [
      { role: "system", content: "客户端模板" },
      { role: "developer", content: "另一个模板" },
      { role: "user", content: "你好" },
    ],
  }
  const out = promptGuard(body, ctx({ mode: "custom", prompt: "网关提示词" }))
  check("只保留一条 system", out.messages.filter((m) => m.role === "system").length === 1)
  check("system 内容为网关提示词", out.messages[0].content === "网关提示词")
  check("user 消息保留", out.messages.some((m) => m.content === "你好"))
  check("developer 已删除", !out.messages.some((m) => m.role === "developer"))
  check("其余字段保留", out.model === "x")
}

// 11. Anthropic 顶层 system
{
  const body = { system: "客户端模板", messages: [{ role: "user", content: "hi" }] }
  const out = promptGuard(body, ctx({ mode: "custom", prompt: "网关提示词" }))
  check("顶层 system 被替换", out.system === "网关提示词")
  check("messages 未受影响", out.messages.length === 1)
}

// 12. Responses instructions
{
  const body = {
    instructions: "客户端模板",
    input: [
      { type: "message", role: "system", content: "另一个" },
      { type: "message", role: "user", content: "hi" },
    ],
  }
  const out = promptGuard(body, ctx({ mode: "custom", prompt: "网关提示词" }))
  check("instructions 被替换", out.instructions === "网关提示词")
  check("input 中的 system 项被删", !out.input.some((i) => i.role === "system"))
  check("input 中 user 项保留", out.input.some((i) => i.role === "user"))
}

// 13. Gemini systemInstruction
{
  const body = { systemInstruction: { parts: [{ text: "客户端模板" }] }, contents: [] }
  const out = promptGuard(body, ctx({ mode: "custom", prompt: "网关提示词" }))
  check("systemInstruction 被替换", out.systemInstruction.parts[0].text === "网关提示词")
}

// 14. passthrough 不动
{
  const body = { messages: [{ role: "system", content: "客户端模板" }] }
  check("passthrough 返回 undefined", promptGuard(body, ctx({ mode: "passthrough" })) === undefined)
  check("passthrough 不改内容", body.messages[0].content === "客户端模板")
}

// 15. remove 只删不插
{
  const body = { messages: [{ role: "system", content: "模板" }, { role: "user", content: "hi" }] }
  const out = promptGuard(body, ctx({ mode: "remove" }))
  check("remove 删除 system", out.messages.length === 1 && out.messages[0].role === "user")
}

// 16. 无 system 时不改动
{
  const body = { messages: [{ role: "user", content: "hi" }] }
  check("无 system 时返回 undefined", promptGuard(body, ctx({ mode: "custom", prompt: "x" })) === undefined)
}

// 17. 默认提示词可加载
{
  const body = { messages: [{ role: "system", content: "模板" }] }
  const out = promptGuard(body, ctx({ mode: "custom" }))
  check("空配置时用内置默认提示词", out && out.messages[0].content.length > 100)
  check("默认提示词为中文工程助手", out.messages[0].content.includes("工程助手"))
}

// 18. 两个 middleware 叠加
{
  const body = {
    messages: [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude" },
      { role: "user", content: "Main branch (you will usually use this for PRs)" },
    ],
  }
  const a = sanitize(body, ctx())
  const b = promptGuard(a, ctx({ mode: "custom", prompt: "网关提示词" }))
  check("叠加后 system 为网关提示词", b.messages[0].content === "网关提示词")
  check("叠加后 user 中指纹也被改写", b.messages[1].content.includes("Default branch"))
}

console.log(`\n==================================================`)
console.log(`RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)