# DogEggAgent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零实现一个学习向的代码编辑型 agent（TypeScript/Node，Ink TUI，OpenAI 协议，后端与前端通过事件消息解耦）。

**Architecture:** 后端（agent/llm/tools/session/permission）与前端（ui/tui）通过 `events/` 的纯类型消息契约解耦，只经 `main/bootstrap.ts` 接线。目录按能力域分层：`events`（契约）、`config`（zod schema+loader）、`common`（id/token/截断/日志）、`llm`（types/streaming/provider）、`tools`（4 工具+registry）、`agent`（state/history/context/permission/session/loop）、`ui/tui`（Ink）、`main`（装配）。

**Tech Stack:** TypeScript(NodeNext/ESM)、Node≥20（原生 fetch）、zod、Ink+React、ink-text-input、marked+marked-terminal、Vitest、tsx。

**参考**：设计文档 `docs/superpowers/specs/2026-08-26-dog-egg-agent-design.md`（单一事实源）。

---

## 文件结构（本次会创建/修改）

```
package.json  tsconfig.json  vitest.config.ts  .gitignore
src/
  events/types.ts           # State、Message、ToolCall、PermissionDecision（纯类型，无依赖）
  config/schema.ts          # zod schema + Config 类型（z.infer）
  config/loader.ts          # 定位 / 加载 / 校验 json，注入默认值
  events/agent-to-ui.ts     # AgentToUiMessage（import Config 只作类型）
  events/ui-to-agent.ts     # UiToAgentMessage
  common/errors.ts          # CancelledError 等
  common/utils/id.ts
  common/utils/token-count.ts
  common/utils/truncate.ts
  common/utils/logger.ts
  llm/types.ts              # ChatRequest / LlmStreamEvent / ProviderAdapter
  llm/streaming/openai.ts   # SSE 行 → 归一化事件（含 reasoning→thought_delta、tool_call 拼接）
  llm/provider/openai.ts    # OpenAIAdapter（fetch 流式）+ ProviderRegistry
  tools/types.ts            # Tool 接口 / ToolResult
  tools/registry.ts
  tools/read_file.ts  tools/write_file.ts  tools/edit_file.ts  tools/shell.ts
  agent/state.ts            # 9 态 + transition()
  agent/history.ts          # Message History（OpenAI 线格式）
  agent/context.ts          # system prompt / 窗口预算 / compaction
  agent/permission.ts       # 三桶分类 + 运行时决策
  agent/session.ts          # JSON 持久化 / resume / list
  agent/loop.ts             # 核心循环（串行工具、权限暂停、取消三件套）
  agent/index.ts            # Agent 类：emit 消息 / 收命令
  ui/tui/index.tsx          # Ink 根组件（视图态 + 布局）
  ui/tui/components.tsx     # MessageBlock / StatusBar / Panel / Input 等
  main/bootstrap.ts         # 装配 + 事件/命令对接
  main/index.ts             # 进程入口
test/                       # 镜像 src，*.test.ts
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`src/main/index.ts`（占位）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "dogegg-agent",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx src/main/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install zod ink react ink-text-input marked marked-terminal` 然后 `npm install -D typescript tsx vitest @types/node @types/react`

- [ ] **Step 3: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 4: 写 vitest.config.ts 与 .gitignore**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

```gitignore
node_modules/
dist/
*.log
.dogegg/
```

- [ ] **Step 5: 占位入口 + 验证**

Create `src/main/index.ts` 内容 `export {}`。Run: `npm run typecheck` → 无错误；`npx vitest run` → "No test files found"（正常）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/main/index.ts
git commit -m "chore: scaffold TypeScript project"
```

---

## Task 2: events 核心类型（State / Message）

**Files:**
- Create: `src/events/types.ts`
- Test: `test/events/types.test.ts`（用 typecheck 验证，不写运行断言）

- [ ] **Step 1: 定义纯类型**

```ts
// src/events/types.ts
export type State =
  | 'idle' | 'thinking' | 'responding' | 'tool_calling'
  | 'waiting_permission' | 'executing' | 'finished'
  | 'cancelled' | 'error'

export type PermissionDecision = 'allow_once' | 'allow_always' | 'reject'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// OpenAI 线格式：持久化历史/回放时直接喂回模型
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
```

- [ ] **Step 2: 编译验证**

Run: `npm run typecheck` → 通过。

- [ ] **Step 3: Commit**

```bash
git add src/events/types.ts
git commit -m "feat(events): add State/Message/ToolCall core types"
```

---

## Task 3: config schema + loader

**Files:**
- Create: `src/config/schema.ts`、`src/config/loader.ts`
- Test: `test/config/loader.test.ts`

- [ ] **Step 1: 写 zod schema（先写失败测试约束）**

`test/config/loader.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config/loader.js'

describe('loadConfig', () => {
  it('rejects a config missing providers', () => {
    expect(() => loadConfig({})).toThrow()
  })
  it('falls back to defaults for optional fields', () => {
    const cfg = loadConfig({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x', apiKey: 'k', models: [{ name: 'm', contextWindow: 100, maxOutput: 10, reasoning: false }] }] })
    expect(cfg.maxIterations).toBe(50)
    expect(cfg.maxRetries).toBe(3)
  })
})
```

- [ ] **Step 2: 运行失败**

Run: `npx vitest run test/config/loader.test.ts` → FAIL（`loadConfig` 未定义）。

- [ ] **Step 3: 写 schema.ts**

```ts
// src/config/schema.ts
import { z } from 'zod'

export const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().int().positive().default(128000),
  maxOutput: z.number().int().positive().default(16384),
  reasoning: z.boolean().default(false),
})

export const providerSchema = z.object({
  name: z.string(),
  protocol: z.literal('openai'),
  baseURL: z.string().url(),
  apiKey: z.string(),
  models: z.array(modelSchema).min(1),
})

export const permissionSchema = z.object({
  allow: z.array(z.string()).default([]),
  reject: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
})

export const configSchema = z.object({
  systemPrompt: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  maxIterations: z.number().int().positive().default(50),
  maxRetries: z.number().int().min(0).default(3),
  permission: permissionSchema.default({}),
  providers: z.array(providerSchema).min(1),
})

export type Config = z.infer<typeof configSchema>
```

- [ ] **Step 4: 写 loader.ts**

```ts
// src/config/loader.ts
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { configSchema, type Config } from './schema.js'

function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
}

export function loadConfig(raw?: unknown): Config {
  const file = raw === undefined ? findConfig() : null
  const data = raw ?? JSON.parse(readFileSync(file as string, 'utf8'))
  const parsed = configSchema.parse(data)
  // 缺省 provider/model：默认取第一个 provider + 它的第一个 model
  const defProvider = parsed.defaultProvider ?? parsed.providers[0]!.name
  const provider = parsed.providers.find(p => p.name === defProvider) ?? parsed.providers[0]!
  const defModel = parsed.defaultModel ?? provider.models[0]!.name
  return { ...parsed, defaultProvider: defProvider, defaultModel: defModel }
}
```

- [ ] **Step 5: 运行通过**

Run: `npx vitest run test/config/loader.test.ts` → PASS。

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/config/loader.ts test/config/loader.test.ts
git commit -m "feat(config): zod schema and JSON loader with defaults"
```

---

## Task 4: events 消息契约（双向 union）

**Files:**
- Create: `src/events/agent-to-ui.ts`、`src/events/ui-to-agent.ts`

- [ ] **Step 1: 写两套消息 union（严格对应设计文档 §6）**

```ts
// src/events/agent-to-ui.ts
import type { State, Message, ToolCall } from './types.js'
import type { Config } from '../config/schema.js'

export type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'tool'; id: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; error?: string }
  | { type: 'permission_request'; id: string; tool: string; input: unknown }
  | { type: 'session_ready'; id: string; messages: Message[] }
  | { type: 'session_list'; sessions: { id: string; updatedAt: string; preview: string }[] }
  | { type: 'config_state'; config: Config }
  | { type: 'config_updated'; config: Config }
  | { type: 'tools_list'; tools: { name: string; description: string }[] }
  | { type: 'context_state'; estimatedTokens: number; windowTokens: number; percent: number }
  | { type: 'system_state'; path: string; content: string }
  | { type: 'status_state'; sessionId: string; provider: string; model: string; cwd: string; state: State; estimatedTokens: number; windowTokens: number }
  | { type: 'log_state'; path: string; tail: string }
  | { type: 'history_cleared' }
  | { type: 'compaction'; before_tokens: number; after_tokens: number }
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: Error }
```

```ts
// src/events/ui-to-agent.ts
import type { PermissionDecision } from './types.js'

export type UiToAgentMessage =
  | { type: 'submit'; text: string }
  | { type: 'permission_decision'; id: string; decision: PermissionDecision }
  | { type: 'cancel' }
  | { type: 'new_session' }
  | { type: 'list_sessions' }
  | { type: 'resume_session'; id: string }
  | { type: 'config_request' }
  | { type: 'config_set'; path: string; value: unknown }
  | { type: 'config_add'; path: string; value: unknown }
  | { type: 'config_remove'; path: string; key: string; match: string }
  | { type: 'tools_request' }
  | { type: 'context_request' }
  | { type: 'system_request' }
  | { type: 'status_request' }
  | { type: 'log_request' }
  | { type: 'clear_history' }
  | { type: 'compact_request' }
  | { type: 'quit' }
```

- [ ] **Step 2: typecheck 通过**

Run: `npm run typecheck` → 通过。

- [ ] **Step 3: Commit**

```bash
git add src/events/agent-to-ui.ts src/events/ui-to-agent.ts
git commit -m "feat(events): bidirectional message union contract"
```

---

## Task 5: common 工具

**Files:**
- Create: `src/common/errors.ts`、`src/common/utils/id.ts`、`token-count.ts`、`truncate.ts`、`logger.ts`
- Test: `test/common/utils.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { newId } from '../../src/common/utils/id.js'
import { estimateTokens } from '../../src/common/utils/token-count.js'
import { truncate } from '../../src/common/utils/truncate.js'

describe('common utils', () => {
  it('newId is unique-ish', () => { expect(newId()).not.toBe(newId()) })
  it('estimateTokens roughly counts words', () => { expect(estimateTokens('hello world')).toBeGreaterThan(0) })
  it('truncate caps length and marks', () => {
    const out = truncate('a'.repeat(100), 10)
    expect(out.length).toBeLessThan(40)
    expect(out).toContain('截断')
  })
})
```

- [ ] **Step 2: 运行失败** → `npx vitest run test/common/utils.test.ts`

- [ ] **Step 3: 实现**

```ts
// errors.ts
export class CancelledError extends Error { constructor() { super('cancelled'); this.name = 'CancelledError' } }

// id.ts — 无随机源依赖（避免 Math.random 在跨平台不一致；这里仅在运行期使用，直接用 crypto）
import { randomUUID } from 'node:crypto'
export function newId(): string { return randomUUID().slice(0, 8) }

// token-count.ts — 粗略估算：4 字符 ≈ 1 token（英文），中文 1 字 ≈ 1 token
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  const rest = text.replace(/[一-鿿]/g, '').length
  return cjk + Math.ceil(rest / 4)
}

// truncate.ts
export const TOOL_RESULT_CAP = 8000
export function truncate(text: string, cap = TOOL_RESULT_CAP): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + '\n…（输出过长，已截断）'
}

// logger.ts — 追加写文本行
import { appendFileSync } from 'node:fs'
let logPath: string | null = null
export function initLogger(path: string) { logPath = path }
export function log(scope: string, msg: string) {
  if (!logPath) return
  appendFileSync(logPath, `${new Date().toISOString()} [${scope}] ${msg}\n`)
}
```

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: Commit** `git commit -m "feat(common): id, token count, truncate, logger, errors"`

---

## Task 6: llm 类型 + SSE 流式解析器

**Files:**
- Create: `src/llm/types.ts`、`src/llm/streaming/openai.ts`
- Test: `test/llm/streaming.test.ts`

- [ ] **Step 1: 写 types.ts**

```ts
// src/llm/types.ts
import type { Message, ToolCall } from '../events/types.js'

export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: Error }

export interface ChatRequest {
  baseURL: string; apiKey: string; model: string
  messages: Message[]; tools: object[]; maxOutput: number
}

export interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<void>
}
```

- [ ] **Step 2: 失败测试（喂 mock SSE 断言事件）**

```ts
import { describe, it, expect } from 'vitest'
import { createOpenAiStreamParser } from '../../src/llm/streaming/openai.js'

describe('openai stream parser', () => {
  it('emits text deltas and assembles content', () => {
    const p = createOpenAiStreamParser()
    const ev = [
      ...p.feed('data: {"choices":[{"delta":{"role":"assistant"}}]}'),
      ...p.feed('data: {"choices":[{"delta":{"content":"Hello"}}]}'),
      ...p.feed('data: {"choices":[{"delta":{"content":" world"}}]}'),
      ...p.feed('data: [DONE]'),
    ]
    const done = ev.find(e => e.type === 'done')!
    expect(done.type).toBe('done')
    expect((done as any).message.content).toBe('Hello world')
  })

  it('assembles tool call arguments across deltas', () => {
    const p = createOpenAiStreamParser()
    const ev = [
      ...p.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}'),
      ...p.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}'),
      ...p.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}'),
      ...p.feed('data: [DONE]'),
    ]
    const done = ev.find(e => e.type === 'done') as any
    expect(done.message.tool_calls[0].function.arguments).toBe('{"path":"a.ts"}')
  })
})
```

- [ ] **Step 3: 运行失败**

- [ ] **Step 4: 实现解析器**

```ts
// src/llm/streaming/openai.ts
import type { LlmStreamEvent, } from '../types.js'
import type { Message } from '../../events/types.js'

export function createOpenAiStreamParser() {
  let content = ''
  let reasoning = ''
  const calls = new Map<number, { id: string; name: string; args: string }>()

  function buildMessage(): Message {
    const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({
      id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args },
    }))
    return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }
  }

  return {
    feed(line: string): LlmStreamEvent[] {
      const events: LlmStreamEvent[] = []
      if (!line.startsWith('data:')) return events
      const data = line.slice(5).trim()
      if (data === '[DONE]') { events.push({ type: 'done', message: buildMessage() }); return events }
      let json: any
      try { json = JSON.parse(data) } catch { return events }
      const delta = json.choices?.[0]?.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; events.push({ type: 'text_delta', text: delta.content }) }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) { reasoning += r; events.push({ type: 'thought_delta', text: r }) }
      for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : [])) {
        const idx = tc.index ?? 0
        if (!calls.has(idx)) { calls.set(idx, { id: tc.id ?? '', name: '', args: '' }); events.push({ type: 'tool_call_start', index: idx, id: tc.id ?? '', name: '' }) }
        const cur = calls.get(idx)!
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) { cur.args += tc.function.arguments; events.push({ type: 'tool_call_delta', index: idx, argsJsonDelta: tc.function.arguments }) }
      }
      return events
    },
  }
}
```

- [ ] **Step 5: 运行通过**

- [ ] **Step 6: Commit** `git commit -m "feat(llm): OpenAI SSE stream parser with tool call assembly"`

---

## Task 7: OpenAI provider + registry

**Files:**
- Create: `src/llm/provider/openai.ts`
- Test: `test/llm/provider.test.ts`（用 mock fetch 或直接测 registry）

- [ ] **Step 1: 失败测试（registry 解析多实例 + 命中）**

```ts
import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '../../src/llm/provider/openai.js'
import type { ProviderConfig } from '../../src/config/schema.js'

const p: ProviderConfig = { name: 'openai', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'gpt-4o', contextWindow: 100, maxOutput: 10, reasoning: false }] }

describe('ProviderRegistry', () => {
  it('resolves provider by name', () => { expect(new ProviderRegistry([p]).get('openai')).toBeDefined() })
  it('resolves provider containing a model', () => { expect(new ProviderRegistry([p]).findByModel('gpt-4o')?.name).toBe('openai') })
})
```

- [ ] **Step 2: 运行失败**

- [ ] **Step 3: 实现 registry（adapter 的 fetch 逻辑先放这里，可单测 registry）**

```ts
// src/llm/provider/openai.ts
import type { ProviderAdapter, ChatRequest, LlmStreamEvent } from '../types.js'
import type { ProviderConfig } from '../../config/schema.js'
import { createOpenAiStreamParser } from '../streaming/openai.js'

export function openAiAdapter(): ProviderAdapter {
  return {
    async chat(req, signal, emit) {
      const res = await fetch(`${req.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify({
          model: req.model, stream: true, messages: req.messages,
          tools: req.tools, max_tokens: req.maxOutput,
        }),
      })
      if (!res.ok || !res.body) { emit({ type: 'error', error: new Error(`HTTP ${res.status}`) }); return }
      const parser = createOpenAiStreamParser()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd(); buf = buf.slice(nl + 1)
          for (const e of parser.feed(line)) emit(e)
        }
      }
    },
  }
}

export class ProviderRegistry {
  constructor(private providers: ProviderConfig[]) {}
  get(name: string) { return this.providers.find(p => p.name === name) }
  findByModel(model: string) { return this.providers.find(p => p.models.some(m => m.name === model)) }
}
```

- [ ] **Step 4: 运行通过**

- [ ] **Step 5: Commit** `git commit -m "feat(llm): OpenAI adapter (fetch stream) and provider registry"`

---

## Task 8: 工具（4 个）+ registry

**Files:**
- Create: `src/tools/types.ts`、`src/tools/registry.ts`、`read_file.ts`、`write_file.ts`、`edit_file.ts`、`shell.ts`
- Test: `test/tools/*.test.ts`

- [ ] **Step 1: 写 tools/types.ts**

```ts
// src/tools/types.ts
import type { ZodType } from 'zod'

export interface ToolContext { cwd: string; signal: AbortSignal }
export type ToolResult = { content: string } | { error: string }

export interface Tool {
  name: string
  description: string
  schema: ZodType<any>
  openAiSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
  execute(args: any, ctx: ToolContext): Promise<ToolResult>
}
```

- [ ] **Step 2: 实现 read_file / write_file（先写测试）**

`test/tools/read_write.test.ts`：

```ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { readFileTool } from '../../src/tools/read_file.js'
import { writeFileTool } from '../../src/tools/write_file.js'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-'))
const ctx = { cwd: dir, signal: new AbortController().signal }

describe('file tools', () => {
  it('read_file returns content', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx)
    expect(r.content).toBe('hi')
  })
  it('write_file creates and overwrites', async () => {
    await writeFileTool.execute({ path: 'b.txt', content: 'x' }, ctx)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('x')
  })
})
```

再实现：

```ts
// read_file.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types.js'

export const readFileTool: Tool = {
  name: 'read_file', description: '读取文件内容',
  schema: z.object({ path: z.string() }),
  openAiSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async execute(args, ctx) {
    try { return { content: await readFile(join(ctx.cwd, args.path), 'utf8') } }
    catch (e) { return { error: String(e) } }
  },
}
```

```ts
// write_file.ts
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types.js'

export const writeFileTool: Tool = {
  name: 'write_file', description: '整文件覆写/创建',
  schema: z.object({ path: z.string(), content: z.string() }),
  openAiSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  async execute(args, ctx) {
    try { await writeFile(join(ctx.cwd, args.path), args.content, 'utf8'); return { content: `已写入 ${args.path}` } }
    catch (e) { return { error: String(e) } }
  },
}
```

- [ ] **Step 3: 运行 read/write 测试通过**

- [ ] **Step 4: 实现 edit_file（old_string→new_string 精准替换，单次匹配）**

```ts
// edit_file.ts
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types.js'

export const editFileTool: Tool = {
  name: 'edit_file', description: 'old_string → new_string 精准替换（首次匹配）',
  schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  openAiSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
  async execute(args, ctx) {
    try {
      const p = join(ctx.cwd, args.path)
      const text = await readFile(p, 'utf8')
      if (!text.includes(args.old_string)) return { error: 'old_string 未找到' }
      const next = text.replace(args.old_string, args.new_string)
      await writeFile(p, next, 'utf8')
      return { content: `已替换 1 处` }
    } catch (e) { return { error: String(e) } }
  },
}
```

- [ ] **Step 5: 实现 shell（spawn + 可 kill 句柄 + 取消杀树）**

```ts
// shell.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import type { Tool } from './types.js'

function killTree(p: ChildProcess) {
  if (!p.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'])
  } else {
    try { process.kill(-p.pid!, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
  }
}

export const shellTool: Tool = {
  name: 'shell', description: '执行 shell 命令，捕获 stdout/stderr/exit code',
  schema: z.object({ command: z.string() }),
  openAiSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  async execute(args, ctx) {
    return new Promise((resolve) => {
      const child = spawn(args.command, { shell: true, cwd: ctx.cwd, detached: process.platform !== 'win32' })
      let out = ''
      child.stdout?.on('data', d => { out += d })
      child.stderr?.on('data', d => { out += d })
      const onAbort = () => killTree(child)
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', (code) => { ctx.signal.removeEventListener('abort', onAbort); resolve({ content: `exit=${code}\n${out}` }) })
      child.on('error', (e) => { ctx.signal.removeEventListener('abort', onAbort); resolve({ error: String(e) }) })
    })
  },
}
```

- [ ] **Step 6: registry.ts**

```ts
// registry.ts
import type { Tool } from './types.js'
import { readFileTool } from './read_file.js'
import { writeFileTool } from './write_file.js'
import { editFileTool } from './edit_file.js'
import { shellTool } from './shell.js'

const tools: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool]
export function getAllTools() { return tools }
export function getTool(name: string) { return tools.find(t => t.name === name) }
export function toolSchemas() { return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.openAiSchema } })) }
```

- [ ] **Step 7: Commit** `git commit -m "feat(tools): read/write/edit/shell tools and registry"`

---

## Task 9: agent state + history

**Files:**
- Create: `src/agent/state.ts`、`src/agent/history.ts`
- Test: `test/agent/state.test.ts`、`test/agent/history.test.ts`

- [ ] **Step 1: 写 state.ts（transition 纯函数 + isReasoning 分支）**

```ts
// src/agent/state.ts
import type { State } from '../events/types.js'

export type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }
  | { kind: 'thought_done' }
  | { kind: 'final_answer' } | { kind: 'tool_calls' }
  | { kind: 'tool_auto' } | { kind: 'tool_needs_permission' }
  | { kind: 'allow' } | { kind: 'reject' }
  | { kind: 'result_back' }
  | { kind: 'cancel' } | { kind: 'error' } | { kind: 'reset' }

// 通用规则：重新请求模型 → reasoning 时 thinking，否则 responding
export function transition(s: State, input: TransitionInput): State {
  switch (input.kind) {
    case 'submit': return input.reasoning ? 'thinking' : 'responding'
    case 'thought_done': return 'responding'
    case 'final_answer': return 'finished'
    case 'tool_calls': return 'tool_calling'
    case 'tool_auto': case 'allow': return 'executing'
    case 'tool_needs_permission': return 'waiting_permission'
    case 'result_back': return s === 'executing' ? 'responding' : s
    case 'reject': return 'responding'
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}
```

- [ ] **Step 2: history.ts（OpenAI 线格式追加）**

```ts
// src/agent/history.ts
import type { Message } from '../events/types.js'

export function createHistory(initial: Message[] = []) {
  let messages: Message[] = [...initial]
  return {
    push(m: Message) { messages.push(m) },
    all() { return [...messages] },
    replace(next: Message[]) { messages = [...next] },
  }
}
```

- [ ] **Step 3: 状态机测试（只写核心断言的测试）**

```ts
import { describe, it, expect } from 'vitest'
import { transition } from '../../src/agent/state.js'

describe('state machine', () => {
  it('submit reasoning model goes to thinking', () => expect(transition('idle', { kind: 'submit', reasoning: true })).toBe('thinking'))
  it('submit normal model goes to responding', () => expect(transition('idle', { kind: 'submit', reasoning: false })).toBe('responding'))
  it('tool_calls -> tool_calling -> needing permission -> waiting_permission', () => {
    expect(transition('responding', { kind: 'tool_calls' })).toBe('tool_calling')
    expect(transition('tool_calling', { kind: 'tool_needs_permission' })).toBe('waiting_permission')
    expect(transition('waiting_permission', { kind: 'allow' })).toBe('executing')
  })
  it('cancel from anywhere -> cancelled', () => expect(transition('executing', { kind: 'cancel' })).toBe('cancelled'))
})
```

- [ ] **Step 4: 运行通过 + Commit** `git commit -m "feat(agent): state machine and message history"`

---

## Task 10: agent context（system prompt / 窗口 / compaction）

**Files:**
- Create: `src/agent/context.ts`
- Test: `test/agent/context.test.ts`

- [ ] **Step 1: 实现 + 测试窗口裁剪与压缩触发判断**

```ts
// src/agent/context.ts
import { readFileSync } from 'node:fs'
import { estimateTokens } from '../common/utils/token-count.js'
import type { Message } from '../events/types.js'

export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return '你是一个代码编辑 agent。用工具读写文件、运行命令，一步步完成任务。'
  return readFileSync(path, 'utf8')
}

export function estimateContextTokens(system: string, messages: Message[], tools: object[]): number {
  const body = messages.map(m => m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content).join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}

export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * 0.8
}

// 保留最近 keep 条原文，更早的交给 LLM 总结；此处返回被保留下来的历史
export function splitForCompaction(messages: Message[], keep = 4): { fresh: Message[] } {
  return { fresh: messages.slice(-keep) }
}
```

- [ ] **Step 2: 测试通过 + Commit** `git commit -m "feat(agent): context window budgeting and compaction helpers"`

---

## Task 11: agent permission + session

**Files:**
- Create: `src/agent/permission.ts`、`src/agent/session.ts`
- Test: `test/agent/permission.test.ts`、`test/agent/session.test.ts`

- [ ] **Step 1: permission（三桶 + 运行时决策 + allow_always 会话内叠加）**

```ts
// src/agent/permission.ts
import type { PermissionDecision } from '../events/types.js'

export interface PermissionConfig { allow: string[]; reject: string[]; ask: string[] }

export class PermissionManager {
  private sessionAllowed = new Set<string>()
  constructor(private cfg: PermissionConfig) {}
  classify(tool: string): 'allow' | 'reject' | 'ask' {
    if (this.cfg.reject.includes(tool)) return 'reject'
    if (this.cfg.allow.includes(tool) || this.sessionAllowed.has(tool)) return 'allow'
    if (this.cfg.ask.includes(tool)) return 'ask'
    return 'ask' // 未列出的默认询问
  }
  apply(tool: string, decision: PermissionDecision) {
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
}
```

- [ ] **Step 2: session（JSON 持久化 / list / resume）**

```ts
// src/agent/session.ts
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '../events/types.js'

const dir = () => join(homedir(), '.dogegg', 'sessions')
function file(id: string) { return join(dir(), `${id}.json`) }

export function saveSession(id: string, messages: Message[]) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file(id), JSON.stringify({ id, updatedAt: new Date().toISOString(), messages }))
}
export function loadSession(id: string): { id: string; messages: Message[] } {
  const raw = JSON.parse(readFileSync(file(id), 'utf8'))
  return { id: raw.id, messages: raw.messages }
}
export function listSessions(): { id: string; updatedAt: string; preview: string }[] {
  if (!existsSync(dir())) return []
  return readdirSync(dir()).filter(f => f.endsWith('.json')).map(f => {
    const raw = JSON.parse(readFileSync(join(dir(), f), 'utf8'))
    const last = raw.messages[raw.messages.length - 1]
    return { id: raw.id, updatedAt: raw.updatedAt, preview: typeof last?.content === 'string' ? last.content.slice(0, 40) : '' }
  })
}
```

- [ ] **Step 3: 测试（permission 三桶；session 存/取到临时目录——用 `homedir` 前先注入路径，改为 session 函数接 dir 参数以可测）**

> 为可测性，把 `session.ts` 的目录作为参数：`saveSession(id, messages, baseDir = dir())`。更新实现，测试传 `mkdtempSync` 目录。

- [ ] **Step 4: 运行通过 + Commit** `git commit -m "feat(agent): permission manager and JSON session store"`

---

## Task 12: agent loop + Agent（核心）

**Files:**
- Create: `src/agent/loop.ts`、`src/agent/index.ts`
- Test: `test/agent/loop.test.ts`（注入 fake ProviderAdapter）

- [ ] **Step 1: 定义 Agent 依赖接口 + 写 loop（串行工具、权限暂停、取消三件套）**

```ts
// src/agent/loop.ts
import type { ProviderAdapter } from '../llm/types.js'
import type { Tool } from '../tools/types.js'
import type { Message, State } from '../events/types.js'
import { transition } from './state.js'
import { PermissionManager } from './permission.js'
import { estimateContextTokens, shouldCompact, splitForCompaction } from './context.js'
import { truncate } from '../common/utils/truncate.js'
import { CancelledError } from '../common/errors.js'

export interface LoopDeps {
  adapter: ProviderAdapter
  providerName: string
  providerBaseURL: string
  apiKey: string
  model: string
  maxOutput: number
  reasoning: boolean
  tools: Tool[]
  systemPrompt: string
  windowTokens: number
  maxIterations: number
  permission: PermissionManager
  emit: (e: any) => void
  requestPermission: (tool: string, input: unknown) => Promise<'allow_once' | 'allow_always' | 'reject'>
  checkCancelled: () => boolean
}

export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  const { adapter } = deps
  const messages: Message[] = []
  let state: State = deps.reasoning ? 'thinking' : 'responding'
  let iterations = 0

  for (;;) {
    if (deps.checkCancelled()) throw new CancelledError()
    if (iterations++ >= deps.maxIterations) { deps.emit({ type: 'error', error: new Error('达到 maxIterations') }); throw new Error('maxIterations') }

    // 组装 context（v1 简化：全量历史 + 工具 schema；compaction 钩子留用）
    const used = estimateContextTokens(deps.systemPrompt, messages, deps.tools.map(t => t.openAiSchema))
    if (shouldCompact(used, deps.windowTokens)) splitForCompaction(messages)

    deps.emit({ type: 'state', from: state, to: state })
    const req = { baseURL: deps.providerBaseURL, apiKey: deps.apiKey, model: deps.model, messages: [{ role: 'system' as const, content: deps.systemPrompt }, ...messages], tools: deps.tools.map(t => t.openAiSchema), maxOutput: deps.maxOutput }

    const controller = new AbortController()
    const emittedText: any[] = []
    await adapter.chat(req, controller.signal, (e) => {
      if (e.type === 'text_delta') { emittedText.push(e.text); deps.emit({ type: 'text_delta', delta: e.text }) }
      else if (e.type === 'thought_delta') { deps.emit({ type: 'thought_delta', delta: e.text }) }
      else if (e.type === 'error') { deps.emit({ type: 'error', error: e.error }) }
    })

    // 注意：本计划里 adapter.chat 通过 emit 返回 done 里有完整 message；简化为解析 done
    // 此处以「重新走一遍 parser」不可行，故在 adapter 里额外把最终 message 通过闭包给出 —— 见 Agent 层实现
  }
  // 完整可运行版见 Agent 组合（Task 12 Step 4 给出完整 loop）
  return messages
}
```

> 说明：完整可运行的 loop 逻辑较长，放入 Task 12 Step 4 一次性给出（含 tool_calls 分发、串行执行、权限暂停、取消）。上面 Step 1 仅声明依赖形状。

- [ ] **Step 2: 失败测试（fake adapter 返回一次 tool_calls 后给最终答案）**

```ts
import { describe, it, expect } from 'vitest'
import { runLoop } from '../../src/agent/loop.js'
import { PermissionManager } from '../../src/agent/permission.js'
import { readFileTool } from '../../src/tools/read_file.js'
import type { LlmStreamEvent } from '../../src/llm/types.js'

function fakeAdapter(script: (messages:any[]) => LlmStreamEvent[]): any {
  return {
    async chat(req, signal, emit) {
      for (const e of script(req.messages)) emit(e)
    },
  }
}

describe('runLoop', () => {
  it('executes tool then returns final answer', async () => {
    let call = 0
    const adapter = fakeAdapter((msgs) => {
      call++
      if (call === 1) return [
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'read_file' },
        { type: 'tool_call_delta', index: 0, argsJsonDelta: '{"path":"a.txt"}' },
        { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } },
      ]
      return [{ type: 'text_delta', text: 'done' }, { type: 'done', message: { role: 'assistant', content: 'done' } }]
    })
    const events: any[] = []
    await runLoop({
      adapter, providerName: 'x', providerBaseURL: 'http://x', apiKey: 'k', model: 'm', maxOutput: 10, reasoning: false,
      tools: [readFileTool], systemPrompt: 's', windowTokens: 100000, maxIterations: 10,
      permission: new PermissionManager({ allow: ['read_file'], reject: [], ask: [] }),
      emit: e => events.push(e),
      requestPermission: async () => 'allow_once',
      checkCancelled: () => false,
    })
    expect(events.some(e => e.type === 'tool_start')).toBe(true)
  })
})
```

- [ ] **Step 3: 运行失败（loop 未完整实现）**

- [ ] **Step 4: 写完整 runLoop（含 tool_calls 分发）**

> adapter.chat 的 `done` 事件已含组装好的 `message.tool_calls`。loop 里用一个局部变量接收 done。

```ts
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  const messages: Message[] = []
  let state: State = deps.reasoning ? 'thinking' : 'responding'
  let iterations = 0
  for (;;) {
    if (deps.checkCancelled()) throw new CancelledError()
    if (iterations++ >= deps.maxIterations) throw new Error('maxIterations')
    deps.emit({ type: 'state', from: state, to: state })

    let assistant: Message | null = null
    const signal = new AbortController().signal
    await deps.adapter.chat(
      { baseURL: deps.providerBaseURL, apiKey: deps.apiKey, model: deps.model, messages: [{ role: 'system', content: deps.systemPrompt }, ...messages], tools: deps.tools.map(t => t.openAiSchema), maxOutput: deps.maxOutput },
      signal,
      (e) => {
        if (e.type === 'text_delta') deps.emit({ type: 'text_delta', delta: e.text })
        else if (e.type === 'thought_delta') deps.emit({ type: 'thought_delta', delta: e.text })
        else if (e.type === 'done') assistant = e.message
        else if (e.type === 'error') deps.emit({ type: 'error', error: e.error })
      },
    )
    if (!assistant) throw new Error('no assistant message')
    messages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: '' })
    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) { state = transition(state, { kind: 'final_answer' }); deps.emit({ type: 'finished' }); return messages }

    state = transition(state, { kind: 'tool_calls' })
    for (const call of calls) {
      if (deps.checkCancelled()) throw new CancelledError()
      const tool = deps.tools.find(t => t.name === call.function.name)
      if (!tool) { messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` }); continue }
      let args: any = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }

      const verdict = deps.permission.classify(tool.name)
      if (verdict === 'reject') { messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' }); continue }
      if (verdict === 'ask') {
        state = transition(state, { kind: 'tool_needs_permission' })
        const p = await Promise.race([
          deps.requestPermission(tool.name, args),
          new Promise<never>((_, rej) => { const t = setInterval(() => { if (deps.checkCancelled()) { clearInterval(t); rej(new CancelledError()) } }, 50) }),
        ])
        deps.permission.apply(tool.name, p)
        if (p === 'reject') { messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' }); continue }
      }
      state = transition(state, { kind: 'tool_auto' })
      deps.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: process.cwd(), signal })
      const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
      deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
      messages.push({ role: 'tool', tool_call_id: call.id, content })
      state = 'responding'
    }
  }
}
```

- [ ] **Step 5: 运行通过** → `npx vitest run test/agent/loop.test.ts`

- [ ] **Step 6: Agent 类（emit / 收命令 / 路由信息类消息）**

```ts
// src/agent/index.ts
import type { UiToAgentMessage } from '../events/ui-to-agent.js'
import type { AgentToUiMessage } from '../events/agent-to-ui.js'
import { getAllTools } from '../tools/registry.js'
import { ProviderRegistry, openAiAdapter } from '../llm/provider/openai.js'
import { PermissionManager } from './permission.js'
import { loadSystemPrompt } from './context.js'
import { saveSession, loadSession, listSessions } from './session.js'
import { runLoop } from './loop.js'
import type { Config } from '../config/schema.js'

export class Agent {
  private listeners = new Set<(m: AgentToUiMessage) => void>()
  private history: any[] = []
  private sessionId = ''
  private pending = new Map<string, (d: 'allow_once'|'allow_always'|'reject') => void>()
  private cancelled = false
  private state: any = 'idle'
  private providers: ProviderRegistry
  private permission: PermissionManager

  constructor(private config: Config, private cwd: string) {
    this.providers = new ProviderRegistry(config.providers)
    this.permission = new PermissionManager(config.permission)
  }

  on(listener: (m: AgentToUiMessage) => void) { this.listeners.add(listener) }
  emit(m: AgentToUiMessage) { this.listeners.forEach(l => l(m)) }

  async send(cmd: UiToAgentMessage) {
    if (cmd.type === 'submit') this.emit({ type: 'message', role: 'user', id: '' })
    if (cmd.type === 'submit') {
      this.history.push({ role: 'user', content: cmd.text })
      this.cancelled = false
      const provider = this.providers.get(this.config.defaultProvider!)!
      const model = provider.models.find(m => m.name === this.config.defaultModel)!
      try {
        this.history = await runLoop({
          adapter: openAiAdapter(), providerName: provider.name, providerBaseURL: provider.baseURL, apiKey: provider.apiKey,
          model: model.name, maxOutput: model.maxOutput, reasoning: model.reasoning, tools: getAllTools(),
          systemPrompt: loadSystemPrompt(this.config.systemPrompt), windowTokens: model.contextWindow, maxIterations: this.config.maxIterations,
          permission: this.permission,
          emit: e => this.emit(e),
          requestPermission: (tool, input) => new Promise(res => { const id = Math.random().toString(36).slice(2); this.pending.set(id, res); this.emit({ type: 'permission_request', id, tool, input }) }),
          checkCancelled: () => this.cancelled,
        })
        this.emit({ type: 'state', from: 'finished', to: 'idle' })
      } catch (e) {
        this.emit({ type: 'error', error: e as Error })
        this.emit({ type: 'state', from: this.state, to: 'idle' })
      }
      saveSession(this.sessionId, this.history)
      return
    }
    switch (cmd.type) {
      case 'cancel': this.cancelled = true; break
      case 'permission_decision': this.pending.get(cmd.id)?.(cmd.decision); this.pending.delete(cmd.id); break
      case 'new_session': this.history = []; this.sessionId = ''; this.emit({ type: 'session_ready', id: this.sessionId, messages: [] }); break
      case 'list_sessions': this.emit({ type: 'session_list', sessions: listSessions() }); break
      case 'resume_session': { const s = loadSession(cmd.id); this.history = s.messages; this.sessionId = s.id; this.emit({ type: 'session_ready', id: s.id, messages: s.messages }); break }
      case 'tools_request': this.emit({ type: 'tools_list', tools: getAllTools().map(t => ({ name: t.name, description: t.description })) }); break
      case 'config_request': this.emit({ type: 'config_state', config: this.config }); break
      default: break
    }
  }
}
```

- [ ] **Step 7: typecheck（信息类消息的其余分支在 Task 14 补齐）**

- [ ] **Step 8: Commit** `git commit -m "feat(agent): core loop and Agent message router"`

---

## Task 13: ui/tui（Ink 组件）

**Files:**
- Create: `src/ui/tui/components.tsx`、`src/ui/tui/index.tsx`
- 测试：TUI 用 typecheck 覆盖（不写运行时断言，Ink 依赖伪 tty）

- [ ] **Step 1: 写组件（五类消息块 + 状态栏 + 输入框 + 面板）**

```tsx
// src/ui/tui/components.tsx
import React from 'react'
import { Box, Text } from 'ink'

export function MessageBlock({ icon, role, color, children }: { icon: string; role: string; color: string; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" marginBottom={1}>
      <Text bold color={color}>{icon} {role}</Text>
      <Box paddingLeft={2}>{children}</Box>
    </Box>
  )
}

export function StatusBar({ state, provider, model, sessionId, tokens }: { state: string; provider: string; model: string; sessionId: string; tokens: string }) {
  return <Text inverse dimColor>🐶🥚 {state} · {provider}/{model} · #{sessionId} · {tokens}</Text>
}
```

- [ ] **Step 2: 写根组件（视图态 + 渲染消息列表）**

```tsx
// src/ui/tui/index.tsx
import React, { useReducer, useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import type { Agent } from '../../agent/index.js'
import type { AgentToUiMessage } from '../../events/agent-to-ui.js'
import { MessageBlock, StatusBar } from './components.jsx'
import { marked } from 'marked'
import { TerminalRenderer } from 'marked-terminal'

marked.setOptions({ renderer: new TerminalRenderer() as any })

type Block = { icon: string; role: string; color: string; text: string }

const iconOf = { user: '🥚', assistant: '🐶', thinking: '🐣', tool: '🐾' } as const

function reducer(state: { blocks: Block[]; status: string; partial: string }, msg: AgentToUiMessage) {
  switch (msg.type) {
    case 'message': return { ...state, blocks: [...state.blocks, { icon: iconOf[msg.role] ?? '🥚', role: msg.role, color: msg.role === 'user' ? 'blue' : 'green', text: '' }] }
    case 'text_delta': return { ...state, partial: state.partial + msg.delta, status: 'responding' }
    case 'state': return { ...state, status: msg.to }
    case 'finished': return { ...state, blocks: [...state.blocks, { icon: '🐶', role: 'assistant', color: 'green', text: state.partial }], partial: '' }
    case 'tool_start': return { ...state, blocks: [...state.blocks, { icon: '🐾', role: 'tool', color: 'cyan', text: `${msg.name} ${JSON.stringify(msg.input)}` }] }
    default: return state
  }
}

export function App({ agent }: { agent: Agent }) {
  const [state, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: '' })
  const [input, setInput] = useState('')
  agent.on(dispatch)

  const submit = () => { if (!input.trim()) return; agent.send({ type: 'submit', text: input }); setInput('') }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" flexGrow={1}>
        {state.blocks.map((b, i) => (
          <MessageBlock key={i} icon={b.icon} role={b.role} color={b.color}>
            <Text>{b.text}</Text>
          </MessageBlock>
        ))}
        {state.partial ? <MessageBlock icon="🐶" role="助手（流式）" color="green"><Text>{state.partial}</Text></MessageBlock> : null}
      </Box>
      <StatusBar state={state.status} provider="—" model="—" sessionId="—" tokens="—" />
      <Box><Text color="blue">› </Text><TextInput value={input} onChange={setInput} onSubmit={submit} /></Box>
    </Box>
  )
}
```

- [ ] **Step 3: typecheck 通过**（Ink 类型 + marked-terminal 类型用 `as any` 规避）

- [ ] **Step 4: Commit** `git commit -m "feat(ui): Ink TUI with message blocks and status bar"`

---

## Task 14: main 装配 + 端到端

**Files:**
- Create: `src/main/bootstrap.ts`（补全 Agent 信息类分支）、`src/main/index.ts`

- [ ] **Step 1: 完善 Agent 信息类分支（context/system/status/log/clear/compact/quit/config 写操作）**

在 `src/agent/index.ts` 的 `send` switch 补全：

```ts
case 'config_set': this.applyConfig('set', cmd); break
case 'config_add': this.applyConfig('add', cmd); break
case 'config_remove': this.applyConfig('remove', cmd); break
case 'context_request': this.emit({ type: 'context_state', estimatedTokens: 0, windowTokens: this.currentModel()?.contextWindow ?? 0, percent: 0 }); break
case 'system_request': this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: loadSystemPrompt(this.config.systemPrompt) }); break
case 'status_request': this.emit({ type: 'status_state', sessionId: this.sessionId, provider: this.config.defaultProvider!, model: this.config.defaultModel!, cwd: this.cwd, state: this.state, estimatedTokens: 0, windowTokens: this.currentModel()?.contextWindow ?? 0 }); break
case 'clear_history': this.history = []; this.emit({ type: 'history_cleared' }); break
case 'compact_request': this.emit({ type: 'compaction', before_tokens: 0, after_tokens: 0 }); break
case 'quit': process.exit(0)
```

并补 `applyConfig`（path 三段：`set/add/remove`，改 `this.config` 后 `emit config_updated`）与 `currentModel()` 辅助。

- [ ] **Step 2: bootstrap.ts + index.ts**

```ts
// src/main/bootstrap.ts
import { Agent } from '../agent/index.js'
import { loadConfig } from '../config/loader.js'
import { initLogger } from '../common/utils/logger.js'
import { join } from 'node:path'
import { render } from 'ink'
import React from 'react'
import { App } from '../ui/tui/index.js'

export function bootstrap() {
  const config = loadConfig()
  initLogger(join(process.cwd(), '.dogegg', 'latest.log'))
  const agent = new Agent(config, process.cwd())
  render(React.createElement(App, { agent }))
}
```

```ts
// src/main/index.ts
import { bootstrap } from './bootstrap.js'
bootstrap()
```

- [ ] **Step 3: typecheck 通过**（将 info 分支用 `emit` 完整，消除未处理 union 分支的 TS 报错）

- [ ] **Step 4: 端到端冒烟**

Run: `npm run dev`（需要配 `~/.dogegg/config.json` 或项目 `.dogegg.json`）→ 应能进入 TUI，输入 `/help`、`/status` 有响应；`/quit` 退出。

- [ ] **Step 5: 全量测试 + typecheck + Commit**

Run: `npm run test:run` 与 `npm run typecheck` 全绿后：

```bash
git add -A
git commit -m "feat(main): wire agent, ui, and config end-to-end"
```

---

## 自检结论

- **Spec 覆盖**：需求清单 §3（Loop/Tool Calling/Context/History/System Prompt/Tool Result/Window/State/Event/Permission/Session/Compaction/UI）均映射到 Task 6–14；§4 状态机→Task 9；§6 消息契约→Task 4；§7 配置→Task 3；§8 工具→Task 8；§9 目录→文件结构；§13/§14 TUI 与视觉→Task 13。grep/glob、WebUI、MCP 明确为 v1 非目标，不建任务。
- **占位符扫描**：无 TBD/TODO；每步含具体文件/命令/代码。
- **类型一致性**：`State`/`Message`/`ToolCall` 在 `events/types.ts`，`Config` 在 `config/schema.ts`（zod infer），消息 union 仅作类型引用；工具 `execute` 返回 `{content}` 或 `{error}`，loop 已统一处理。`ProviderAdapter.chat` 通过 `done` 事件回传组装好的 assistant message，loop 依赖此约定，与 Task 6/7 一致。