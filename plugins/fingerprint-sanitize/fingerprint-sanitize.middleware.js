// 出站指纹脱敏 middleware：把上游内容审核会逐字拦截的客户端模板句改掉。
//
// 背景：Claude Code / Codex CLI 等客户端在 system prompt 里注入若干固定模板句，
// 部分上游（CodeBuddy / CodeArts / 灵犀）按**逐字精确匹配**拦截，而非语义审核。
// 一字之差即可绕过，且语义不变。
//
// 移植自 workbuddy2api 的 internal/upstream/sanitize.go（同源定制）。
//
// 契约（非常重要）：**只破坏上游会拦的指纹，绝不顺手动别的字节。**
// 请求体里同时流动着「模型读到的文件内容」（tool result）与「模型发给工具的
// 编辑参数」（tool_calls.arguments）。这两处一旦被改动，模型算出的 old_string
// 就与磁盘不符，Edit 会报 "String to replace not found in file"。
// 因此这里不做任何「顺手美化」：不 TrimSpace、不规范化空白。
//
// 配置：
//   {"enabled": true, "custom": [["原文","替换"], ...]}

// 剥离层：header 键名即触发（与值无关），整段删除。
const HDR_RE = /x-anthropic-billing-header:[^;\n]*;?\s*/gi
// 剥离层：尾随裸键值（cc_xxx=...;）循环清理。
const KV_RE = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi

// 改写层：全模板句逐字替换（每句只改一个词，语义不变）。
// 顺序有意义：整句条目在前，脱离前缀的残留条目在后。
const REWRITES = [
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will typically use this for PRs)",
  ],
  [
    "you will usually use this for PRs",
    "you will typically use this for PRs",
  ],
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  // DSH (DeepSeek Harness) 的 harness:identity 句被上游当作未授权渠道整包拦截。
  "DeepSeek Harness|DeepSeekRuntime",
]

// 特征预检：任一命中才进入净化（避免普通请求做无用功）。
const FEATURES = [
  "x-anthropic-billing-header",
  "cc_entrypoint=",
  "You are Claude Code",
  "Main branch (",
  "you will usually use this for PRs",
  "You are a coding agent running in the Codex CLI",
  "github.com/anthropics/",
  "DeepSeek Harness",
]

function hasFingerprint(text) {
  for (const f of FEATURES) {
    if (text.includes(f)) return true
  }
  HDR_RE.lastIndex = 0
  return HDR_RE.test(text)
}

// 预检要连 custom 规则一起算：否则用户加的规则永远走不到替换循环。
function shouldSanitize(text, rewrites, extraFeatures) {
  if (hasFingerprint(text)) return true
  for (const f of extraFeatures) {
    if (text.includes(f)) return true
  }
  return false
}

function sanitizeText(text, rewrites, extraFeatures) {
  if (typeof text !== "string" || !text) return text
  if (!shouldSanitize(text, rewrites, extraFeatures)) return text
  for (const [from, to] of rewrites) {
    if (text.includes(from)) text = text.split(from).join(to)
  }
  if (HDR_RE.test(text)) {
    HDR_RE.lastIndex = 0
    text = text.replace(HDR_RE, "")
  }
  if (text.includes("cc_")) {
    let prev = ""
    // 循环清理，直到没有变化（处理粘连的多个裸键值）
    while (prev !== text) {
      prev = text
      KV_RE.lastIndex = 0
      text = text.replace(KV_RE, "")
    }
  }
  return text
}

// 兼容字符串与多模态数组：只动 text part，image / file 等 part 不动。
function sanitizeContent(v, rewrites, extraFeatures) {
  if (typeof v === "string") {
    const s = sanitizeText(v, rewrites, extraFeatures)
    return s !== v ? { value: s, changed: true } : { value: v, changed: false }
  }
  if (Array.isArray(v)) {
    let changed = false
    for (const part of v) {
      if (!part || typeof part !== "object") continue
      if (typeof part.text === "string") {
        const s = sanitizeText(part.text, rewrites, extraFeatures)
        if (s !== part.text) {
          part.text = s
          changed = true
        }
      }
    }
    return { value: v, changed }
  }
  return { value: v, changed: false }
}

// 递归处理已知的请求体形状。只走内容字段，不动 tool_calls.arguments /
// tool result，避免模型算出的编辑定位符与磁盘不一致。
const CONTENT_KEYS = ["content", "system", "instructions", "text"]

function walk(node, rewrites, extraFeatures, depth) {
  if (depth > 12 || !node || typeof node !== "object") return false
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) {
      if (walk(item, rewrites, extraFeatures, depth + 1)) changed = true
    }
    return changed
  }
  for (const key of Object.keys(node)) {
    const val = node[key]
    if (CONTENT_KEYS.includes(key) && (typeof val === "string" || Array.isArray(val))) {
      const r = sanitizeContent(val, rewrites, extraFeatures)
      if (r.changed) {
        node[key] = r.value
        changed = true
      }
      continue
    }
    // messages / input / contents 等容器继续下钻，其余标量字段跳过
    if (val && typeof val === "object") {
      if (walk(val, rewrites, extraFeatures, depth + 1)) changed = true
    }
  }
  return changed
}

export function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object") return
    const o = ctx && ctx.options && typeof ctx.options === "object" ? ctx.options : {}
    if (o.enabled === false) return
    let rewrites = REWRITES.map((r) => (typeof r === "string" ? r.split("|") : r))
    const extraFeatures = []
    if (Array.isArray(o.custom)) {
      for (const pair of o.custom) {
        if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && pair[0]) {
          rewrites = [[pair[0], String(pair[1] ?? "")], ...rewrites]
          extraFeatures.push(pair[0])
        }
      }
    }
    return walk(body, rewrites, extraFeatures, 0) ? body : undefined
  } catch {
    // fail open：任何异常都不阻塞请求
  }
}