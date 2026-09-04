# 06 · 上下文管理与压缩

## History 与 Context 分离（R1）

DogEggAgent 最核心的设计之一——**两份独立的数据**：

| | History（历史） | Context（上下文） |
|---|---|---|
| 用途 | UI 显示历史消息 | 发给模型 |
| 内容 | 完整原文，单调增长 | 可能被压缩 |
| compact 时 | **不动** | 压缩成 `[摘要, 最近 N 条]` |
| 持久化 | 存原文 | 存压缩版 |
| resume 时 | 加载原文 → UI 显示 | 加载压缩版 → 喂模型 |

**为什么分离**：如果只有一份消息列表，压缩后原文就丢了——resume 时用户看不到完整的对话历史。分离后 history 始终完整，context 可以压缩。

### 双写

每条新消息（user/assistant/tool）产生时同时 push 到两者：

```ts
// agent/src/core/agent.ts runTurn()
this.history.push(userMsg)
this.context.push(userMsg)

// loop 返回后
this.context = result.context         // context 可能被压缩
this.history.push(...result.newMessages)  // history 只 append，不被压缩
```

### Session 文件结构

```json
{ "id": "3f2a", "updatedAt": "...", "history": [...], "context": [...], "allowedTools": ["read_file"] }
```

history 存完整原文，context 存压缩版。resume 加载两者。

## Token 估算

不引入 tokenizer（v1 目标是学习，不需要精确），用粗略启发式：

```ts
// agent/src/context/token/estimate.ts
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length   // CJK 字符按 1 token/字
  const rest = text.replace(/[一-鿿]/g, '').length
  return cjk + Math.ceil(rest / 4)                      // 其余按 4 字符 ≈ 1 token
}
```

CJK 感知——中文项目里 CJK 字符 tokenize 比率约 1:1，Latin 约 4:1。

```ts
// agent/src/context/token/budget.ts
function estimateContextTokens(system, messages, tools): number {
  const body = messages.map((m) =>
    m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content
  ).join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}
```

assistant 的 `content` 可能为 null（纯 tool_calls），tool_calls 不在 content 里需单独 stringify。工具 schema 的 JSON 也算进预算——它确实占上下文窗口。

## 工具结果截断

```ts
// agent/src/context/message/truncate.ts
const TOOL_RESULT_CAP = 8000

function truncate(text: string, cap = TOOL_RESULT_CAP): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + '\n…（输出过长，已截断）'
}
```

shell 输出可能几千行——截断到 8000 字符，末尾标注。截断后的内容回填给模型，需保持可读性。

## 上下文压缩

### 触发条件

- **自动**：loop 每轮迭代开头估算 token，超过窗口 80% 时触发。
- **手动**：用户输入 `/compact`，无条件压缩（只要 context 非空）。

```ts
// agent/src/context/compact/trigger.ts
import { COMPACTION_THRESHOLD } from '@dogegg/bridge'
function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * COMPACTION_THRESHOLD  // 80% 而非 100%——留缓冲
}
```

阈值 `0.8` 现已抽成常量 `COMPACTION_THRESHOLD`（`bridge/src/contract/shared.ts`），由 trigger.ts、enforce.ts、run.ts 共用——避免魔法数字在各处分散漂移。

### 压缩流程

```ts
// agent/src/context/compact/compact.ts
async function compactContext(input: {
  context: Message[], systemPrompt, tools, windowTokens,
  summarize: (old: Message[], signal?) => Promise<string>,
  force?: boolean, signal?: AbortSignal
}): Promise<CompactResult> {

  if (context.length === 0) return { compacted: false, ... }          // 空的不压
  if (!force && !shouldCompact(before, windowTokens)) return { ... }   // 自动模式需达阈值

  // 切分：保留最近 keep 条原文，更早的交给 LLM 摘要
  const keep = force ? Math.min(4, Math.max(0, context.length - 1)) : 4
  const { old, fresh } = splitForCompaction(context, keep)

  // 消息太少时全部交给摘要
  const toSummarize = old.length > 0 ? old : fresh
  const toKeep = old.length > 0 ? fresh : []

  const summary = await input.summarize(toSummarize, input.signal)

  // 重建 context：摘要消息 + 保留的近期原文
  const context = [{ role: 'user', content: `[前文摘要]\n${summary}` }, ...toKeep]
  return { compacted: true, context, before, after }
}
```

**force 语义**：
- `force=false`（loop 自动）：仅超 80% 窗口才压。
- `force=true`（`/compact` 手动）：无条件压。消息少时 keep 降为 `length-1`，全部交给摘要。

### 硬上限兜底（enforceContextLimit）

压缩是「软」手段——靠 LLM 摘要把旧消息压成一段。但若单条消息极大（如一次 shell 输出几万 token），或压缩失败降级仍用未压缩 context，压缩后 context 可能仍超阈值。此时 `enforceContextLimit` 作为硬上限兜底：

```ts
// agent/src/context/compact/enforce.ts
export function enforceContextLimit(input: {
  systemPrompt: string; context: Message[]; tools: object[]; windowTokens: number; threshold?: number
}): { context: Message[]; dropped: number } {
  const threshold = input.threshold ?? COMPACTION_THRESHOLD
  const limit = input.windowTokens * threshold
  let context = [...input.context]
  let dropped = 0
  while (context.length > 1 && estimateContextTokens(input.systemPrompt, context, input.tools) > limit) {
    context.shift()  // 从头部丢弃最旧的非 system 消息
    dropped++
  }
  return { context, dropped }
}
```

从头部逐条 `shift` 最旧消息直到降到阈值以下，**保留至少一条**（`context.length > 1` 守卫）确保模型看到最新输入。system 消息不在 context 数组中（由 adapter 拼接），所以这里丢弃的都是非 system 消息。被丢弃的消息在 history 中仍保留——只是不再发给模型，UI 显示不受影响。loop 在压缩后调用它，`dropped > 0` 时原地替换 context（`run.ts` ~110-122）。

### 摘要调用

```ts
// agent/src/context/compact/summarize.ts
async function summarizeHistory(deps, old: Message[], signal?): Promise<string> {
  const assistant = await deps.adapter.chat({
    ...,
    systemPrompt: '你是上下文压缩器。把这段对话压缩成一段简洁的中文摘要，保留关键事实、结论与未完成事项。',
    messages: old,
    tools: [],      // 摘要不需要工具
    maxOutput: 1000,
    maxRetries: 1,
  }, signal, () => {})
  return typeof assistant.content === 'string' ? assistant.content : ''
}
```

"离线"调用——不进 loop、不发 stream 事件、不产生 tool_calls。signal 传递让 cancel 能中断。

### 自动压缩在 loop 里的位置

```ts
// agent/src/loop/run.ts
for (;;) {
  // 检查取消 + 迭代上限
  ...
  // 自动压缩（token 超 80%）
  const used = estimateContextTokens(...)
  if (used > deps.windowTokens * COMPACTION_THRESHOLD) {
    state = trans({ kind: 'compact_start' })  // → compacting
    try {
      const result = await compactContext({ ..., signal: deps.signal })
      if (result.compacted) {
        context.length = 0; context.push(...result.context)  // 原地替换
        deps.emit({ type: 'compaction', ..., source: 'auto' })
      }
    } catch { /* 降级：跳过压缩继续用未压缩 context */ }
    state = trans({ kind: 'compact_done', next: deps.reasoning ? 'thinking' : 'responding' })
  }
  // 调模型
  ...
}
```

压缩失败降级——不 abort turn，用未压缩 context 继续（模型仍能回答，只是窗口可能紧张）。

### 手动 vs 自动的 UI 反馈

手动和自动的 UI 反馈已统一：reducer 对 `compaction` 消息一律在对话流插一条 dim 提示块（`🥚 Context compacted: X → Y tokens`），不弹 overlay。

`compaction` 消息的 `source: 'manual' | 'auto'` 字段仍保留在契约中，但不再驱动 UI 差异（TUI 与 WebUI 均如此——早期"手动弹 overlay"的行为已移除）。
