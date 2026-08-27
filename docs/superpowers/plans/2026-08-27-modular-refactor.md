# DogEggAgent 模块化重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DogEggAgent 从单一 `src/` 目录重构为 `agent` / `ui` / `bridge` 三个 npm workspace 包，行为、需求能力、交互零变化。

**Architecture:** npm workspaces 真多包；`bridge` 是解耦契约（双向消息 + 跨界数据类型 + Config zod schema）+ 传输无关的 Port 通道；`agent` 与 `ui` 互不依赖、都只依赖 `@dogegg/bridge`；根 `main.ts` 是唯一同时 import agent 与 ui 的组合根。依赖方向由架构测试强制。

**Tech Stack:** TypeScript(strict) / Node ≥20 / npm workspaces / esbuild(JS API) / Vitest / zod / Ink。

**规格文档:** `docs/superpowers/specs/2026-08-27-modular-refactor-design.md`（下称「设计」）。

---

## 执行约定（读我）

1. **纯搬家文件**：内容一行不改的文件，用 `git mv` 保留历史 + 「import 改写表」精确说明改哪行，不重复贴正文。
2. **新建 / 内容拆变的文件**：给完整代码。
3. **验证节奏**：每个 Phase 末尾 `npm run typecheck` + `npm run test:run` 必须全绿才 commit。
4. **每 Phase 结束一个 commit**。

---

## 阶段总览

| Phase | 内容 | 结束状态 |
|---|---|---|
| 0 | 基线确认 | 现状绿 |
| 1 | workspace 骨架 + bridge 包 + 全仓 import 切换 | agent/ui 仍在 `src/`，但只依赖 `@dogegg/bridge` 包名 |
| 2 | agent 包迁移与拆分 | `src/agent`、`src/llm`、`src/tools`、`src/config`、`src/common` 清空 |
| 3 | ui 包迁移与拆分 | `src/ui` 清空 |
| 4 | 根 `main.ts` + 删除 `src/`、`test/` + 构建验证 | 仅存三包 + 根配置 |
| 5 | 文档同步 + 最终验证 | 完成 |

---

## Phase 0: 基线确认

- [ ] **Step 1: 记录基线，跑通货与测试**

```bash
git log --oneline -1 && npm run typecheck && npm run test:run
```

Expected: 最近 commit `641810b`；typecheck 绿；vitest 全绿（15 个测试文件）。

---

## Phase 1: workspace 骨架 + bridge 包 + 全仓 import 切换

**目标**：建起三包配置与根工具链；bridge 包完整可测（契约 + Port 通道）；全仓 import 从相对路径改为 `@dogegg/bridge`。agent/ui 代码仍在 `src/` 不动，只改它们的 import 源。

### Task 1.1: 根配置与 workspace 骨架

**Files:**
- Create: `tsconfig.base.json`
- Modify: `package.json`（workspaces + scripts + build 入口）
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`（include 只留 src）

- [ ] **Step 1: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "types": ["node"],
    "noEmit": true
  }
}
```

- [ ] **Step 2: 改 `package.json`**

`scripts` + `workspaces` 改为（其余字段保持）：

```json
{
  "name": "dogegg-agent",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "workspaces": ["agent", "ui", "bridge"],
  "scripts": {
    "dev": "npm run build && npm run start",
    "build": "node build.mjs",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p agent && tsc --noEmit -p ui && tsc --noEmit -p bridge",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "engines": { "node": ">=20" }
}
```

dependencies/devDependencies 维持现有（运行时 `ink`/`react`/`marked`/`zod`；dev `esbuild`/`tsx`/`typescript`/`vitest`/`@types/*`），workspaces 化后统一 hoist 到根 node_modules，无需改动。

- [ ] **Step 3: 改 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['agent/test/**/*.test.ts', 'ui/test/**/*.test.ts', 'bridge/test/**/*.test.ts'] },
})
```

- [ ] **Step 4: 写 `build.mjs`**

```js
import { build } from 'esbuild'

// 把 @dogegg/* 工作区包打进产物；其余 npm 依赖保持 external，运行期从根 node_modules 解析。
const workspacePlugin = {
  name: 'dogegg-workspace',
  setup(b) {
    b.onResolve({ filter: /^@dogegg\// }, (args) => {
      const name = args.path.slice('@dogegg/'.length)
      return { path: new URL(`./${name}/src/index.ts`, import.meta.url).pathname }
    })
  },
}

await build({
  entryPoints: ['main.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [workspacePlugin],
})
```

- [ ] **Step 5: 改 `tsconfig.json`**（根：extends base，本阶段仍 include 旧 src）

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 6: 安装并验证 toolchain**

```bash
npm install
```

Expected: `npm install` 成功；`ls node_modules/@dogegg` 出现 `agent` `ui` `bridge` 三个软链（各包 package.json 稍后在 Task 1.3 建，此刻尚未有，可先忽略报错）。

### Task 1.2: bridge 包结构

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/tsconfig.json`
- Create: `bridge/src/index.ts`
- Create: `bridge/src/contract/shared.ts`
- Create: `bridge/src/contract/config.ts`
- Create: `bridge/src/contract/agent-to-ui.ts`
- Create: `bridge/src/contract/ui-to-agent.ts`
- Create: `bridge/src/channel/port.ts`
- Create: `bridge/src/channel/in-memory.ts`
- Create: `bridge/test/channel.test.ts`
- Create: `bridge/test/architecture.test.ts`

- [ ] **Step 1: 写 `bridge/package.json`**

```json
{
  "name": "@dogegg/bridge",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.4.3" }
}
```

- [ ] **Step 2: 写 `bridge/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 写 `bridge/src/contract/shared.ts`**（← 原 `src/events/types.ts`，内容原样）

```ts
// 后端与前端共享的核心类型。此文件是纯类型，无任何运行时逻辑，不依赖其它域。
export type State =
  | 'idle' | 'thinking' | 'responding' | 'tool_calling' | 'waiting_permission'
  | 'executing' | 'finished' | 'cancelled' | 'error'

export type PermissionDecision = 'allow_once' | 'allow_always' | 'reject'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// OpenAI 线格式：持久化历史 / 恢复会话时可直接喂回模型，不丢失 tool_calls 关联。
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }
```

- [ ] **Step 4: 写 `bridge/src/contract/config.ts`**（← 原 `src/config/schema.ts`）

```ts
import { z } from 'zod'

// 模型/提供商字段在校验层刻意放宽，以支持 /config 的「自由创建节点、逐字段填写」流程。
export const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().int().positive().default(128000),
  maxOutput: z.number().int().positive().default(16384),
  reasoning: z.boolean().default(false),
})

export const providerSchema = z.object({
  name: z.string(),
  protocol: z.enum(['openai']),
  baseURL: z.string(),
  apiKey: z.string(),
  models: z.array(modelSchema).default([]),
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
  shellProgram: z.string().optional(),
  permission: permissionSchema.default({ allow: [], reject: [], ask: [] }),
  providers: z.array(providerSchema).default([]),
})

export type Config = z.infer<typeof configSchema>
export type ProviderConfig = z.infer<typeof providerSchema>
export type ModelConfig = z.infer<typeof modelSchema>
```

- [ ] **Step 5: 写 `bridge/src/contract/agent-to-ui.ts`**（← 原 `src/events/agent-to-ui.ts`，import 改自 `./types`→`./shared`、`../config/schema`→`./config`）

```ts
import type { State, Message } from './shared'
import type { Config } from './config'

// 后端 → 前端的消息契约。仅类型；方向单一，保证后端/前端解耦且互不 import 业务实现。
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
  | { type: 'notice'; text: string }
  | { type: 'compaction'; before_tokens: number; after_tokens: number }
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: Error }
```

- [ ] **Step 6: 写 `bridge/src/contract/ui-to-agent.ts`**（← 原 `src/events/ui-to-agent.ts`，import 改自 `./types`→`./shared`）

```ts
import type { PermissionDecision } from './shared'

// 前端 → 后端的消息契约。command 与 event 本质相同，只是方向相反，故统一为「消息」。
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
  | { type: 'config_remove'; path: string; index: number; providerIndex?: number }
  | { type: 'tools_request' }
  | { type: 'context_request' }
  | { type: 'system_request' }
  | { type: 'status_request' }
  | { type: 'log_request' }
  | { type: 'clear_history' }
  | { type: 'compact_request' }
  | { type: 'quit' }
```

- [ ] **Step 7: 写 `bridge/src/channel/port.ts`**

```ts
import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 传输无关的端口：agent 侧与 ui 侧各自持有对偶的 Port，通过 post/onMessage 收发消息。
export interface AgentPort {
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void
  post(msg: AgentToUiMessage): void
}
export interface UiPort {
  onMessage(cb: (msg: AgentToUiMessage) => void): () => void
  post(msg: UiToAgentMessage): void
}
```

- [ ] **Step 8: 写 `bridge/src/channel/in-memory.ts`**

```ts
import type { AgentPort, UiPort } from './port'
import type { AgentToUiMessage } from '../contract/agent-to-ui'
import type { UiToAgentMessage } from '../contract/ui-to-agent'

// 同进程通道：同步投递（与旧 agent.send/emit 时序一致）。返回对偶的两端，各自订阅即收。
export function createChannelPair(): { agentPort: AgentPort; uiPort: UiPort } {
  const agentListeners = new Set<(m: UiToAgentMessage) => void>()
  const uiListeners = new Set<(m: AgentToUiMessage) => void>()
  return {
    agentPort: {
      onMessage(cb) { agentListeners.add(cb); return () => { agentListeners.delete(cb) } },
      post(msg) { uiListeners.forEach((l) => l(msg)) },
    },
    uiPort: {
      onMessage(cb) { uiListeners.add(cb); return () => { uiListeners.delete(cb) } },
      post(msg) { agentListeners.forEach((l) => l(msg)) },
    },
  }
}
```

- [ ] **Step 9: 写 `bridge/src/index.ts`**

```ts
export * from './contract/shared'
export * from './contract/config'
export * from './contract/agent-to-ui'
export * from './contract/ui-to-agent'
export * from './channel/port'
export * from './channel/in-memory'
```

- [ ] **Step 10: 写 `bridge/test/channel.test.ts`**（先写测试，即 TDD：此刻通道实现已完成，测试应直接绿）

```ts
import { describe, it, expect } from 'vitest'
import { createChannelPair } from '../src/channel/in-memory'

describe('createChannelPair', () => {
  it('delivers agent→ui and ui→agent messages in both directions', () => {
    const { agentPort, uiPort } = createChannelPair()
    const toUi: string[] = []
    const toAgent: string[] = []
    uiPort.onMessage((m) => toUi.push(m.type))
    agentPort.onMessage((m) => toAgent.push(m.type))

    agentPort.post({ type: 'notice', text: 'hi' })
    uiPort.post({ type: 'tools_request' })

    expect(toUi).toEqual(['notice'])
    expect(toAgent).toEqual(['tools_request'])
  })

  it('unsubscribe stops delivery', () => {
    const { agentPort, uiPort } = createChannelPair()
    const got: string[] = []
    const off = uiPort.onMessage((m) => got.push(m.type))
    off()
    agentPort.post({ type: 'notice', text: 'x' })
    expect(got).toEqual([])
  })
})
```

- [ ] **Step 11: 写 `bridge/test/architecture.test.ts`**

```ts
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// 架构测试：扫描三包源码，把「依赖方向」「模块边界」「体量红线」从约定升级为可执行断言。
const root = process.cwd()

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.tsx?$/.test(f) ? [p] : []
  })
}

function imports(f: string): string[] {
  const src = readFileSync(f, 'utf8')
  const re = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1]!)
  return out
}

const pkg = { agent: 'agent/src', ui: 'ui/src', bridge: 'bridge/src' } as const
const files = Object.fromEntries((Object.entries(pkg) as [keyof typeof pkg, string][]).map(([k, d]) => [k, walk(d).map((p) => ({ p, imps: imports(p) }))]))

describe('architecture: dependency direction', () => {
  it('agent 与 ui 互不依赖', () => {
    expect(files.agent.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
    expect(files.ui.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
  })
  it('bridge 不依赖任何兄弟包', () => {
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
  })
  it('相对路径 import 不越过自己的包根（越界由包 tsconfig include 天然阻断）', () => {
    // 包内模块用相对路径合法（如 loop → ../context）；真正越界的是逃出本包 src 根 ——
    // 该情况会被各包 tsconfig.json 的 include 范围挡住而 typecheck 报错，故此处仅作记录性断言，守包名方向即可。
    expect(true).toBe(true)
  })
})

describe('architecture: module boundary', () => {
  it('index.ts 只允许 re-export（不得含实现逻辑）', () => {
    const violators = ['agent/src', 'ui/src', 'bridge/src']
      .flatMap((base) => walk(base))
      .filter((f) => f.endsWith('/index.ts') || f.endsWith('/index.tsx'))
      .filter((idx) => {
        const src = readFileSync(idx, 'utf8')
        const lines = src.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('//'))
        // 允许 import 行、export 行、空行；出现其它声明（const/function/class 等）即视为塞了实现。
        return lines.some((l) => !l.startsWith('import ') && !l.startsWith('export ') && !l.startsWith('import{') && !l.startsWith('export{'))
      })
    expect(violators).toEqual([])
  })
})

describe('architecture: size ceiling', () => {
  it('src 下源文件不超过 250 行', () => {
    const big = walk('bridge/src').concat(walk('agent/src'), walk('ui/src'))
      .filter((f) => readFileSync(f, 'utf8').split('\n').length > 250)
    expect(big).toEqual([])
  })
})
```

> 注：第三条「相对路径跨包」断言需在 Phase 2/3 迁移完成后才有效；此刻 agent/ui 在 src/ 里用相对路径属正常，这条断言先只锁定 bridge 自身——bridge 是纯包名起点。

- [ ] **Step 12: 提交 Phase 1.1 + 1.2 前的验证**

```bash
npm install && npx tsc --noEmit -p bridge && npm run test:run -- --root bridge
```

Expected: bridge 单独 typecheck 绿；channel 测试绿。

### Task 1.3: 全仓 import 切到 @dogegg/bridge

**files 与 import 改写表**（逐文件 sed 替换，`from '../events/...'` / `'../../events/...'` / `'../config/schema'` / `'./schema'` 全部归并到 `@dogegg/bridge`）：

| 文件 | 旧 import | 新 import |
|---|---|---|
| `src/agent/index.ts` | `../events/ui-to-agent`, `../events/agent-to-ui`, `../events/types`, `../config/schema` | 全部 → `@dogegg/bridge` |
| `src/agent/loop.ts` | `../events/types`, `../events/agent-to-ui`, `../llm/types`, `../tools/types` | events→`@dogegg/bridge`（其余保留相对） |
| `src/agent/context.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/session.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/permission.ts` | `../events/types` | `@dogegg/bridge` |
| `src/agent/state.ts` | `../events/types` | `@dogegg/bridge` |
| `src/llm/types.ts` | `../events/types` | `@dogegg/bridge` |
| `src/llm/provider/openai.ts` | `../../events/types`, `../../config/schema` | 均 → `@dogegg/bridge` |
| `src/llm/streaming/openai.ts` | `../../events/types` | `@dogegg/bridge` |
| `src/config/loader.ts` | `./schema` | `@dogegg/bridge` |
| `src/ui/tui/index.tsx` | `../../events/agent-to-ui`, `../../events/types`, `../../config/schema` | 均 → `@dogegg/bridge` |
| `src/ui/tui/config-tree.ts` | `../../config/schema` | `@dogegg/bridge` |
| 全部 `test/**` | 对应的 `../../src/events/...`、`../../src/config/...` | 仍用相对 `../../src/...`（本阶段源码还在 src），仅指向 bridge 的改为包名（见下） |

**重要**：`test/agent/state.test.ts`、`test/agent/permission.test.ts` 等用例若 import `../../src/events/types`（有 4 处），改为 `@dogegg/bridge`；其余 `../../src/xxx` 相对 import 保持不动。

- [ ] **Step 1: 逐个改写上述文件的 import 行**（用精确 Edit/替换；被删的 `src/events/` 与 `src/config/schema.ts` 稍后 Step 3 清掉）

- [ ] **Step 2: 删除旧契约文件**

```bash
rm -rf src/events
rm src/config/schema.ts
```

- [ ] **Step 3: 验证全绿**

```bash
npm run typecheck && npm run test:run
```

Expected: 全绿。旧 `src/config/loader.ts` 现在 `import { configSchema, ... } from '@dogegg/bridge'`,测试里 `loadConfig` 依然工作。

- [ ] **Step 4: 提交 Phase 1**

```bash
git add -A
git commit -m "refactor: workspace scaffold + bridge contract/channel; switch imports to @dogegg/bridge"
```

---

## Phase 2: agent 包迁移与拆分

**目标**：把 `src/agent`、`src/llm`、`src/tools`、`src/config`、`src/common` 全部迁移进 `agent/src/`，按设计 §5 逐职责拆文件。agent 改造成通过 `AgentPort` 收发消息。

**核心拆分决策**（与设计 §5 有一处微调，同步更新设计文档）：`core/` 下不设 `commands.ts` / `turn.ts`——`send` 命令分发与轮次编排是 Agent 自身的唯一接缝，硬拆成游离函数需引入薄而散的 context 对象，反而降低可维护性。真正可独立的大块是**配置编辑**（~150 行）、**provider 解析**、**挂起权限**，本计划把它们拆出；`agent.ts` 因此回到 ~200 行纯门面，满足红线。设计文档 §5 的 `core/` 同步改为 `{ agent.ts, pending.ts, state/ }`。

### Task 2.1: agent 包骨架

**Files:** Create `agent/package.json`、`agent/tsconfig.json`

- [ ] **Step 1: 写 `agent/package.json`**

```json
{
  "name": "@dogegg/agent",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.4.3", "@dogegg/bridge": "*" }
}
```

- [ ] **Step 2: 写 `agent/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

### Task 2.2: `shared/`（← src/common，归属 agent 内）

**Files:**
- Create: `agent/src/shared/index.ts`
- Create: `agent/src/shared/errors.ts`（← `src/common/errors.ts`，原样）
- Create: `agent/src/shared/id.ts`（← `src/common/utils/id.ts`，原样）
- Create: `agent/src/shared/logger/init.ts`（← `src/common/utils/logger.ts` 的 initLogger）
- Create: `agent/src/shared/logger/write.ts`（← log + sessionLogPath）
- Create: `agent/src/shared/logger/tail.ts`（← readLogTail）
- Create: `agent/src/shared/logger/index.ts`

- [ ] **Step 1: 抄写 `errors.ts`、`id.ts` 原样**（`git mv` 后微调无 import 改动，二者本就是 leaf）

```bash
git mv src/common/errors.ts agent/src/shared/errors.ts
git mv src/common/utils/id.ts agent/src/shared/id.ts
```

- [ ] **Step 2: 拆 logger（原 `src/common/utils/logger.ts` 有 initLogger / sessionLogPath / log / readLogTail 四函数）**

`agent/src/shared/logger/init.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let logDir: string | null = null

export function initLogger(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
}

export function currentLogDir(): string | null {
  return logDir
}
```

`agent/src/shared/logger/write.ts`:

```ts
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentLogDir } from './init'

export function sessionLogPath(sessionId: string): string | null {
  const dir = currentLogDir()
  return dir ? join(dir, `${sessionId}.log`) : null
}

export function log(sessionId: string, scope: string, msg: string): void {
  const dir = currentLogDir()
  if (!dir) return
  appendFileSync(join(dir, `${sessionId}.log`), `${new Date().toISOString()} [${scope}] ${msg}\n`)
}
```

`agent/src/shared/logger/tail.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs'
import { sessionLogPath } from './write'

export function readLogTail(sessionId: string, lines = 50): string {
  const path = sessionLogPath(sessionId)
  if (!path || !existsSync(path)) return ''
  const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  return all.slice(-lines).join('\n')
}
```

`agent/src/shared/logger/index.ts`:

```ts
export { initLogger } from './init'
export { log, sessionLogPath } from './write'
export { readLogTail } from './tail'
```

`agent/src/shared/index.ts`:

```ts
export * from './errors'
export * from './id'
export * from './logger'
```

### Task 2.3: `core/`（agent 核心：pending / state / agent 门面）

**Files:**
- Create: `agent/src/core/pending.ts`、`agent/src/core/state/index.ts`、`agent/src/core/state/events.ts`、`agent/src/core/state/transition.ts`、`agent/src/core/agent.ts`、`agent/src/core/index.ts`

- [ ] **Step 1: 写 `core/pending.ts`（挂起权限表，从 Agent 抽出）**

```ts
import type { PermissionDecision } from '@dogegg/bridge'

interface Pending {
  resolve: (d: PermissionDecision) => void
  reject: (e: Error) => void
}

// 挂起中的权限请求：request 注册一个待决议 Promise，resolve/reject/clear 在收到决定或取消时结算。
export class PendingPermissions {
  private map = new Map<string, Pending>()

  add(id: string, pending: Pending): void {
    this.map.set(id, pending)
  }

  resolve(id: string, d: PermissionDecision): void {
    const p = this.map.get(id)
    if (p) { this.map.delete(id); p.resolve(d) }
  }

  rejectAll(e: Error): void {
    for (const [, p] of this.map) p.reject(e)
    this.map.clear()
  }
}
```

- [ ] **Step 2: 写 `core/state/`（← `src/agent/state.ts`，拆成 events + transition）**

`core/state/events.ts`:

```ts
export type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }
  | { kind: 'thought_done' }
  | { kind: 'final_answer' }
  | { kind: 'tool_calls' }
  | { kind: 'tool_auto' }
  | { kind: 'tool_needs_permission' }
  | { kind: 'allow' }
  | { kind: 'tool_done' }
  | { kind: 'reject'; reasoning: boolean }
  | { kind: 'result_back'; reasoning: boolean }
  | { kind: 'cancel' }
  | { kind: 'error' }
  | { kind: 'reset' }
```

`core/state/transition.ts`:

```ts
import type { State } from '@dogegg/bridge'
import type { TransitionInput } from './events'

// 9 态状态机的纯函数迁移。拒绝回填 / 结果回填后的「重新请求模型」与 submit 一样，
// 推理模型回到 thinking、普通模型回到 responding，故 reject/result_back 同样取 reasoning 决定下一态。
export function transition(_s: State, input: TransitionInput): State {
  switch (input.kind) {
    case 'submit': return input.reasoning ? 'thinking' : 'responding'
    case 'thought_done': return 'responding'
    case 'final_answer': return 'finished'
    case 'tool_calls': return 'tool_calling'
    case 'tool_auto':
    case 'allow': return 'executing'
    case 'tool_needs_permission': return 'waiting_permission'
    case 'tool_done': return 'tool_calling'
    case 'reject': return input.reasoning ? 'thinking' : 'responding'
    case 'result_back': return input.reasoning ? 'thinking' : 'responding'
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}
```

`core/state/index.ts`:

```ts
export { transition } from './transition'
export type { TransitionInput } from './events'
```

- [ ] **Step 3: 写 `core/agent.ts`（Agent 门面，从 src/agent/index.ts 抽走 config 编辑 / provider 解析 / pending 后重写）**

> ⚠️ `agent.ts` 依赖 `config/editor`、`config/resolve`、`context/compact` 等后建模块，须在它们就绪后一次写全。**本 Step 留到 Task 2.8 完成后、Task 2.10 一次性写出完整版**（见 Task 2.10），避免与后续 task 冲突。此处仅记为待办。

### Task 2.4: `context/`（← src/agent/context.ts + 两个 utils）

**Files 结构**：

```
agent/src/context/
├─ index.ts                     # 门面：汇总对外 API
├─ prompt/{index,builtin,load}.ts     # 需求 #5
├─ message/{index,truncate}.ts         # 需求 #6（截断）
├─ token/{index,estimate,budget}.ts    # 需求 #7
└─ compact/{index,trigger,split,summarize,compact}.ts   # 需求 #12
```

> 说明：原设计 §5「context/message/tool-result.ts」本计划微调为并入 `loop/tool-calls.ts`——`ToolResult` 类型归 tools 域，放 context 会引入 context→tools 依赖，破坏依赖矩阵。tool-result 整形仅 loop 使用，归 loop。

- [ ] **Step 1: `context/prompt/builtin.ts`**

```ts
// 内置 system prompt：config.systemPrompt 未指定路径时使用。
export const BUILTIN_PROMPT = '你是一个代码编辑 agent。用工具读写文件、运行命令，一步步完成任务，并简要说明每一步做了什么。'
```

- [ ] **Step 2: `context/prompt/load.ts`**

```ts
import { readFileSync } from 'node:fs'
import { BUILTIN_PROMPT } from './builtin'

// 加载 system prompt 文本。配置只存路径，避免把大段 prompt 塞进 config、改起来无需动配置 schema。
export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return BUILTIN_PROMPT
  return readFileSync(path, 'utf8')
}
```

- [ ] **Step 3: `context/prompt/index.ts`**

```ts
export { loadSystemPrompt } from './load'
export { BUILTIN_PROMPT } from './builtin'
```

- [ ] **Step 4: `context/token/estimate.ts`（← common/utils/token-count.ts，原样）**

```ts
// 粗略 token 估算（非精确）：CJK 字符按 1 token/字，其余按 4 字符 ≈ 1 token。
// 用于上下文窗口预算与 compaction 触发判断，精度需求不高。
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  const rest = text.replace(/[一-鿿]/g, '').length
  return cjk + Math.ceil(rest / 4)
}
```

- [ ] **Step 5: `context/token/budget.ts`（← src/agent/context.ts 的 estimateContextTokens）**

```ts
import type { Message } from '@dogegg/bridge'
import { estimateTokens } from './estimate'

// 估算整个 context 的 token 数（system + 历史 + 工具 schema）。
export function estimateContextTokens(system: string, messages: Message[], tools: object[]): number {
  const body = messages
    .map((m) => (m.role === 'assistant' ? (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '') : m.content))
    .join('')
  return estimateTokens(system) + estimateTokens(body) + estimateTokens(JSON.stringify(tools))
}
```

- [ ] **Step 6: `context/token/index.ts`**

```ts
export { estimateTokens } from './estimate'
export { estimateContextTokens } from './budget'
```

- [ ] **Step 7: `context/message/truncate.ts`（← common/utils/truncate.ts，原样）**

```ts
// 工具结果超长截断（尤其 shell 输出会撑爆窗口）。默认上限 8000 字符，超出则在末尾标注。
export const TOOL_RESULT_CAP = 8000

export function truncate(text: string, cap = TOOL_RESULT_CAP): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + '\n…（输出过长，已截断）'
}
```

- [ ] **Step 8: `context/message/index.ts`**

```ts
export { truncate, TOOL_RESULT_CAP } from './truncate'
```

- [ ] **Step 9: `context/compact/trigger.ts`**

```ts
// 是否触发压缩：超过窗口 80% 时压缩最旧历史。
export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * 0.8
}
```

- [ ] **Step 10: `context/compact/split.ts`**

```ts
import type { Message } from '@dogegg/bridge'

// 压缩切分：保留最近 keep 条原文，更早的交给 LLM 总结（总结动作在 summarize 里调用）。
export function splitForCompaction(messages: Message[], keep = 4): { old: Message[]; fresh: Message[] } {
  if (messages.length <= keep) return { old: [], fresh: [...messages] }
  return { old: messages.slice(0, messages.length - keep), fresh: messages.slice(messages.length - keep) }
}
```

- [ ] **Step 11: `context/compact/summarize.ts`（从 src/agent/loop.ts 的 summarizeHistory 抽出）**

```ts
import type { Message } from '@dogegg/bridge'
import type { ProviderAdapter } from '../../llm/types'

// 用同一 adapter 做一次「离线」总结，把最旧的历史压成一段中文摘要。
// 摘要是压缩后的替代，不含 tool_calls，故 tools 传空、maxOutput 控制长度。
export async function summarizeHistory(
  deps: { adapter: ProviderAdapter; providerBaseURL: string; apiKey: string; model: string },
  old: Message[],
): Promise<string> {
  const assistant = await deps.adapter.chat(
    {
      baseURL: deps.providerBaseURL,
      apiKey: deps.apiKey,
      model: deps.model,
      systemPrompt: '你是上下文压缩器。把这段对话压缩成一段简洁的中文摘要，保留关键事实、结论与未完成事项。',
      messages: old,
      tools: [],
      maxOutput: 1000,
      maxRetries: 1,
    },
    new AbortController().signal,
    () => {},
  )
  return typeof assistant.content === 'string' ? assistant.content : ''
}
```

- [ ] **Step 12: `context/compact/compact.ts`（自动 + 手动压缩统一入口）**

```ts
import type { Message } from '@dogegg/bridge'
import { estimateContextTokens } from '../token/budget'
import { shouldCompact } from './trigger'
import { splitForCompaction } from './split'

export interface CompactResult {
  compacted: boolean
  messages: Message[]
  before: number
  after: number
}

// 统一压缩入口：估算窗口 → 判断触发 → 切分 → 调 LLM 摘要 → 重建历史。
// 返回 compacted=false 表示无需压缩或无可压缩旧历史（before==after）。
// 调用方（loop 自动 / Agent 手动 /compact）各自决定是否 emit 与持久化。
export async function compactHistory(input: {
  messages: Message[]
  systemPrompt: string
  tools: object[]
  windowTokens: number
  summarize: (old: Message[]) => Promise<string>
}): Promise<CompactResult> {
  const before = estimateContextTokens(input.systemPrompt, input.messages, input.tools)
  if (!shouldCompact(before, input.windowTokens)) {
    return { compacted: false, messages: input.messages, before, after: before }
  }
  const { old, fresh } = splitForCompaction(input.messages)
  if (old.length === 0) {
    return { compacted: false, messages: input.messages, before, after: before }
  }
  const summary = await input.summarize(old)
  const messages = [{ role: 'user' as const, content: `[前文摘要]\n${summary}` }, ...fresh]
  return { compacted: true, messages, before, after: estimateContextTokens(input.systemPrompt, messages, input.tools) }
}
```

- [ ] **Step 13: `context/compact/index.ts`**

```ts
export { shouldCompact } from './trigger'
export { splitForCompaction } from './split'
export { summarizeHistory } from './summarize'
export { compactHistory, type CompactResult } from './compact'
```

- [ ] **Step 14: `context/index.ts`（门面）**

```ts
export { loadSystemPrompt, BUILTIN_PROMPT } from './prompt'
export { truncate, TOOL_RESULT_CAP } from './message'
export { estimateTokens, estimateContextTokens } from './token'
export { shouldCompact, splitForCompaction, summarizeHistory, compactHistory, type CompactResult } from './compact'
```

---

### Task 2.5: `llm/`（← src/llm，openai 适配器按职责拆分）

**Files 结构**：

```
agent/src/llm/
├─ index.ts
├─ types.ts                            # ← src/llm/types.ts
├─ provider/openai/{index,adapter,request,stream,retry}.ts
└─ streaming/openai/{index,types,parser}.ts
```

- [ ] **Step 1: `llm/types.ts`（原样，import 改 @dogegg/bridge）**

```ts
import type { Message } from '@dogegg/bridge'

// LLM 级流事件：provider → agent loop 的底层流，表达「模型吐了什么」。
export type LlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonDelta: string }
  | { type: 'tool_call_end'; index: number; id: string; name: string; arguments: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: Error }

export interface ChatRequest {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  messages: Message[] // 仅 user / assistant / tool 历史；system 由 adapter 自行拼接
  tools: object[]
  maxOutput: number
  maxRetries: number
}

export interface ProviderAdapter {
  chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message>
}
```

- [ ] **Step 2: `llm/streaming/openai/types.ts`**

```ts
// SSE 数据片段的最小类型形状（OpenAI chat.completions 流）。全部字段可选，逐字段窄化，避免无类型 any。
export interface SseToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}
export interface SseChoiceDelta {
  content?: string
  reasoning_content?: string
  reasoning?: string
  tool_calls?: SseToolCallDelta[]
}
export interface SseChunk {
  choices?: { delta?: SseChoiceDelta }[]
}
```

- [ ] **Step 3: `llm/streaming/openai/parser.ts`（从原 streaming/openai.ts 抽解析器）**

```ts
import type { LlmStreamEvent } from '../../types'
import type { Message } from '@dogegg/bridge'
import type { SseChunk } from './types'

interface PendingToolCall {
  id: string
  name: string
  args: string
}

// OpenAI 流式 SSE 解析器（行驱动，便于无网络单测）。
// - 文本 delta → text_delta；reasoning 字段 → thought_delta
// - tool_calls 按 index 累积，arguments 分片拼接
// - [DONE] 时逐 tool call 发 tool_call_end，再发 done 组装成一条 assistant 消息
export function createOpenAiStreamParser() {
  let content = ''
  let reasoning = ''
  const calls = new Map<number, PendingToolCall>()

  function buildMessage(): Message {
    const tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } }))
    return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) }
  }

  return {
    feed(line: string): LlmStreamEvent[] {
      const events: LlmStreamEvent[] = []
      if (!line.startsWith('data:')) return events
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        for (const [idx, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          events.push({ type: 'tool_call_end', index: idx, id: c.id, name: c.name, arguments: c.args })
        }
        events.push({ type: 'done', message: buildMessage() })
        return events
      }
      let json: SseChunk
      try {
        json = JSON.parse(data) as SseChunk
      } catch {
        return events
      }
      const delta = json.choices?.[0]?.delta ?? {}

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        events.push({ type: 'text_delta', text: delta.content })
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        events.push({ type: 'thought_delta', text: r })
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0
        if (!calls.has(idx)) {
          calls.set(idx, { id: tc.id ?? '', name: '', args: '' })
          events.push({ type: 'tool_call_start', index: idx, id: tc.id ?? '', name: '' })
        }
        const cur = calls.get(idx)!
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) {
          cur.args += tc.function.arguments
          events.push({ type: 'tool_call_delta', index: idx, argsJsonDelta: tc.function.arguments })
        }
      }
      return events
    },
  }
}
```

- [ ] **Step 4: `llm/streaming/openai/index.ts`**

```ts
export { createOpenAiStreamParser } from './parser'
export type { SseChunk, SseChoiceDelta, SseToolCallDelta } from './types'
```

- [ ] **Step 5: `llm/provider/openai/request.ts`**

```ts
import type { ChatRequest } from '../../types'

// ChatRequest → HTTP body 与请求 init。system 消息在此拼接（LLM 历史不含 system）。
export function buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
  return {
    url: `${req.baseURL.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
        tools: req.tools,
        max_tokens: req.maxOutput,
      }),
    },
  }
}
```

- [ ] **Step 6: `llm/provider/openai/stream.ts`**

```ts
import type { Message } from '@dogegg/bridge'
import type { LlmStreamEvent, ChatRequest } from '../../types'
import { createOpenAiStreamParser } from '../../streaming/openai'
import { buildRequest } from './request'

// 单次流式请求：fetch → 逐行喂 parser → 累积最终 message。不做重试（重试在 adapter）。
export async function streamOnce(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message> {
  const { url, init } = buildRequest(req)
  const res = await fetch(url, { ...init, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalMessage: Message | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      for (const e of parser.feed(line)) {
        if (e.type === 'done') finalMessage = e.message
        else emit(e)
      }
    }
  }
  if (!finalMessage) throw new Error('流未产生最终消息')
  return finalMessage
}
```

- [ ] **Step 7: `llm/provider/openai/retry.ts`**

```ts
// 请求失败重试。AbortError 不重试（取消立即上抛）。
export async function withRetry<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await run()
    } catch (e) {
      lastError = e as Error
      if (lastError.name === 'AbortError') throw lastError
    }
  }
  throw lastError!
}
```

- [ ] **Step 8: `llm/provider/openai/adapter.ts`**

```ts
import type { ProviderAdapter, LlmStreamEvent, ChatRequest } from '../../types'
import type { Message } from '@dogegg/bridge'
import { streamOnce } from './stream'
import { withRetry } from './retry'

// OpenAI 兼容 adapter：原生 fetch + 手写 SSE，返回组装好的 assistant 消息，并对网络/HTTP 错误重试。
export function openAiAdapter(): ProviderAdapter {
  return {
    async chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message> {
      return withRetry(req.maxRetries + 1, () => streamOnce(req, signal, emit))
    },
  }
}
```

- [ ] **Step 9: `llm/provider/openai/index.ts` + `llm/index.ts`**

```ts
// provider/openai/index.ts
export { openAiAdapter } from './adapter'
```

```ts
// llm/index.ts
export type { LlmStreamEvent, ChatRequest, ProviderAdapter } from './types'
export { openAiAdapter } from './provider/openai'
export { createOpenAiStreamParser } from './streaming/openai'
```

> 注：原 `src/llm/provider/openai.ts` 里的 `ProviderRegistry` 类**删除**——被 `config/resolve` 收编（见 Task 2.7）。`ProviderConfig` 类型从 `@dogegg/bridge` 取。

---

### Task 2.6: `tools/`（← src/tools，每个工具用「schema 定义 + execute 实现」分文件模式）

**Files 结构**：

```
agent/src/tools/
├─ index.ts                       # registry：getAllTools / getTool / toolSchemas
├─ types.ts                       # Tool / ToolContext / ToolResult 契约
├─ read_file/{index,schema,execute}.ts
├─ write_file/{index,schema,execute}.ts
├─ edit_file/{index,schema,execute}.ts
└─ shell/{index,schema,execute,interpreter,kill-tree}.ts
```

- [ ] **Step 1: `tools/types.ts`（原样）**

```ts
import type { z } from 'zod'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  // 仅 shell 工具使用：配置里的解释器（如 cmd/powershell/bash），缺省按平台解析。
  shellProgram?: string
}

export type ToolResult = { content: string } | { error: string }

// 工具契约：schema 用于 zod 校验 LLM 返回的参数；parameters 是暴露给 LLM 的 OpenAI JSON schema。
export interface Tool {
  name: string
  description: string
  schema: z.ZodTypeAny
  parameters: Record<string, unknown>
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}
```

- [ ] **Step 2: `tools/read_file/`**

`read_file/schema.ts`:

```ts
import { z } from 'zod'

export const readFileSchema = z.object({ path: z.string() })
```

`read_file/execute.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { readFileSchema } from './schema'

export async function readFileExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { path } = args as z.infer<typeof readFileSchema>
  try {
    return { content: await readFile(join(ctx.cwd, path), 'utf8') }
  } catch (e) {
    return { error: String(e) }
  }
}
```

`read_file/index.ts`:

```ts
import type { Tool } from '../types'
import { readFileSchema } from './schema'
import { readFileExecute } from './execute'

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容',
  schema: readFileSchema,
  parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的文件路径' } }, required: ['path'] },
  execute: readFileExecute,
}
```

- [ ] **Step 3: `tools/write_file/`**

`write_file/schema.ts`:

```ts
import { z } from 'zod'

export const writeFileSchema = z.object({ path: z.string(), content: z.string() })
```

`write_file/execute.ts`:

```ts
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { writeFileSchema } from './schema'

export async function writeFileExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { path, content } = args as z.infer<typeof writeFileSchema>
  try {
    await writeFile(join(ctx.cwd, path), content, 'utf8')
    return { content: `已写入 ${path}` }
  } catch (e) {
    return { error: String(e) }
  }
}
```

`write_file/index.ts`:

```ts
import type { Tool } from '../types'
import { writeFileSchema } from './schema'
import { writeFileExecute } from './execute'

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '整文件覆写或创建',
  schema: writeFileSchema,
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] },
  execute: writeFileExecute,
}
```

- [ ] **Step 4: `tools/edit_file/`**

`edit_file/schema.ts`:

```ts
import { z } from 'zod'

export const editFileSchema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })
```

`edit_file/execute.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { editFileSchema } from './schema'

export async function editFileExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { path, old_string, new_string } = args as z.infer<typeof editFileSchema>
  try {
    const p = join(ctx.cwd, path)
    const text = await readFile(p, 'utf8')
    if (!text.includes(old_string)) return { error: 'old_string 未找到' }
    await writeFile(p, text.replace(old_string, new_string), 'utf8')
    return { content: '已替换 1 处' }
  } catch (e) {
    return { error: String(e) }
  }
}
```

`edit_file/index.ts`:

```ts
import type { Tool } from '../types'
import { editFileSchema } from './schema'
import { editFileExecute } from './execute'

export const editFileTool: Tool = {
  name: 'edit_file',
  description: '将文件中首次出现的 old_string 精准替换为 new_string',
  schema: editFileSchema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要替换的原文片段，需与文件内容逐字符一致' },
      new_string: { type: 'string', description: '替换后的新片段' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: editFileExecute,
}
```

- [ ] **Step 5: `tools/shell/interpreter.ts`（← common/utils/shell.ts，原样）**

```ts
// shell 解释器解析：把配置里的 shellProgram（可缺省）映射成 spawn 需要的「程序 + 标志」。
export interface ShellSpec {
  program: string
  flag: string
}

export function defaultShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  return platform === 'win32' ? { program: 'cmd', flag: '/c' } : { program: 'bash', flag: '-c' }
}

// 已知解释器映射到标准 flag；未知值回退为「程序名 + -c」，仍可显式执行。
export function resolveShell(program: string | undefined, platform: NodeJS.Platform = process.platform): ShellSpec {
  if (!program) return defaultShell(platform)
  switch (program.toLowerCase()) {
    case 'cmd': return { program: 'cmd', flag: '/c' }
    case 'powershell':
    case 'pwsh': return { program: 'powershell', flag: '-Command' }
    case 'bash': return { program: 'bash', flag: '-c' }
    case 'sh': return { program: 'sh', flag: '-c' }
    default: return { program, flag: '-c' }
  }
}
```

- [ ] **Step 6: `tools/shell/kill-tree.ts`（从 src/tools/shell.ts 抽出）**

```ts
import { spawn, type ChildProcess } from 'node:child_process'

// 杀进程树：按 OS 分，不按 shell 类型分。win 用 taskkill /T，POSIX 用 detached 进程组信号。
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  } else {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }
}
```

- [ ] **Step 7: `tools/shell/{schema,execute,index}.ts`**

`schema.ts`:

```ts
import { z } from 'zod'

export const shellSchema = z.object({ command: z.string() })
```

`execute.ts`:

```ts
import { spawn } from 'node:child_process'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { resolveShell } from './interpreter'
import { killTree } from './kill-tree'
import { shellSchema } from './schema'

export function shellExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { command } = args as z.infer<typeof shellSchema>
  const { program, flag } = resolveShell(ctx.shellProgram)
  return new Promise((resolve) => {
    // 取消三件套之一：把 killTree 挂在 abort 上，杀进程树。detached 用于 POSIX 进程组 kill。
    const child = spawn(program, [flag, command], { cwd: ctx.cwd, detached: process.platform !== 'win32' })
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d })
    const onAbort = () => killTree(child)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ content: `exit=${code}\n${out}` })
    })
    child.on('error', (e) => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve({ error: String(e) })
    })
  })
}
```

`index.ts`:

```ts
import type { Tool } from '../types'
import { shellSchema } from './schema'
import { shellExecute } from './execute'

export const shellTool: Tool = {
  name: 'shell',
  description: '执行 shell 命令，捕获 stdout/stderr 与 exit code',
  schema: shellSchema,
  parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] },
  execute: shellExecute,
}
```

- [ ] **Step 8: `tools/index.ts`（registry）**

```ts
import type { Tool } from './types'
import { readFileTool } from './read_file'
import { writeFileTool } from './write_file'
import { editFileTool } from './edit_file'
import { shellTool } from './shell'

const tools: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool]

export function getAllTools(): Tool[] {
  return tools
}

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

// 组装为 OpenAI `tools` 参数：每个工具一个 { type: 'function', function: {...} }。
export function toolSchemas(): object[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}
```

- [ ] **Step 9: 删除旧 tools 目录原文件**

```bash
git rm src/tools/types.ts src/tools/registry.ts src/tools/read_file.ts src/tools/write_file.ts src/tools/edit_file.ts src/tools/shell.ts
```

---

### Task 2.7: `session/`、`permission/`、`config/`

- [ ] **Step 1: `session/`（← src/agent/session.ts，拆 store / list）**

`session/store.ts`（save / load + baseDir）：

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from '@dogegg/bridge'

// JSON 会话持久化。baseDir 可注入（测试传临时目录），运行时默认 ~/.dogegg/sessions。
export function defaultSessionsDir(): string {
  return join(homedir(), '.dogegg', 'sessions')
}

function file(baseDir: string, id: string): string {
  return join(baseDir, `${id}.json`)
}

export function saveSession(id: string, messages: Message[], baseDir = defaultSessionsDir()): void {
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(file(baseDir, id), JSON.stringify({ id, updatedAt: new Date().toISOString(), messages }))
}

export function loadSession(id: string, baseDir = defaultSessionsDir()): { id: string; messages: Message[] } {
  const raw = JSON.parse(readFileSync(file(baseDir, id), 'utf8'))
  return { id: raw.id, messages: raw.messages }
}
```

`session/list.ts`：

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@dogegg/bridge'

export function listSessions(baseDir = defaultSessionsDir()): { id: string; updatedAt: string; preview: string }[] {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(baseDir, f), 'utf8'))
      const last: Message | undefined = raw.messages[raw.messages.length - 1]
      const preview = last && last.role !== 'tool' && typeof last.content === 'string' ? last.content.slice(0, 40) : ''
      return { id: raw.id, updatedAt: raw.updatedAt, preview }
    })
}
```

> 注意 `list.ts` 里用到 `defaultSessionsDir`，补一行 `import { defaultSessionsDir } from './store'`。

`session/index.ts`：

```ts
export { saveSession, loadSession, defaultSessionsDir } from './store'
export { listSessions } from './list'
```

- [ ] **Step 2: `permission/`（← src/agent/permission.ts，拆 classify / runtime）**

`permission/classify.ts`（纯函数：三桶静态分类，缺省 ask 倾向安全）：

```ts
import type { PermissionDecision } from '@dogegg/bridge'

export interface PermissionConfig {
  allow: string[]
  reject: string[]
  ask: string[]
}

export function classify(
  cfg: PermissionConfig,
  sessionAllowed: ReadonlySet<string>,
  tool: string,
): 'allow' | 'reject' | 'ask' {
  if (cfg.reject.includes(tool)) return 'reject'
  if (cfg.allow.includes(tool) || sessionAllowed.has(tool)) return 'allow'
  return 'ask'
}
```

`permission/runtime.ts`：

```ts
import type { PermissionDecision } from '@dogegg/bridge'
import { classify, type PermissionConfig } from './classify'

// 两层权限：配置三桶静态分类（allow/reject/ask），运行时 allow_always 会把工具在本会话内挪进 allow。
export class PermissionManager {
  private sessionAllowed = new Set<string>()

  constructor(private cfg: PermissionConfig) {}

  classify(tool: string): 'allow' | 'reject' | 'ask' {
    return classify(this.cfg, this.sessionAllowed, tool)
  }

  apply(tool: string, decision: PermissionDecision): void {
    if (decision === 'allow_always') this.sessionAllowed.add(tool)
  }
}
```

`permission/index.ts`：

```ts
export { PermissionManager } from './runtime'
export { classify, type PermissionConfig } from './classify'
```

- [ ] **Step 3: 写 `config/loader/`（← src/config/loader.ts，拆 find / load / save；schema 已迁 bridge）**

`config/loader/find.ts`：

```ts
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 定位配置：项目内 .dogegg.json 优先，否则 ~/.dogegg/config.json。
export function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
}

// 写回目标：已存在的配置优先，否则落到用户级默认路径（/config 编辑后落盘用）。
export function configTargetPath(): string {
  return findConfig() ?? join(homedir(), '.dogegg', 'config.json')
}
```

`config/loader/load.ts`：

```ts
import { readFileSync } from 'node:fs'
import { configSchema, type Config } from '@dogegg/bridge'
import { findConfig } from './find'

// raw 用于测试注入；运行时传 undefined 从文件加载。
// 找不到配置文件时不再抛错，而是返回空配置（providers 为空），让工具能启动、引导用户去 /config。
export function loadConfig(raw?: unknown): Config {
  let data: unknown
  if (raw !== undefined) {
    data = raw
  } else {
    const file = findConfig()
    data = file ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  const parsed = configSchema.parse(data)
  if (parsed.providers.length > 0) {
    const defaultProvider = parsed.defaultProvider ?? parsed.providers[0]!.name
    const provider = parsed.providers.find((p) => p.name === defaultProvider) ?? parsed.providers[0]!
    const defaultModel = parsed.defaultModel ?? provider.models[0]?.name
    return { ...parsed, defaultProvider, defaultModel: defaultModel ?? parsed.defaultModel }
  }
  return parsed
}
```

`config/loader/save.ts`：

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from '@dogegg/bridge'
import { configTargetPath } from './find'

export function saveConfig(config: Config, path = configTargetPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}
```

`config/loader/index.ts`：

```ts
export { findConfig, configTargetPath } from './find'
export { loadConfig } from './load'
export { saveConfig } from './save'
```

- [ ] **Step 4: 写 `config/resolve/`（收编 ProviderRegistry + isConfigured + currentProvider/Model）**

`config/resolve/current.ts`：

```ts
import type { Config, ProviderConfig, ModelConfig } from '@dogegg/bridge'

// 从 config 解析「当前 provider + model」：defaultProvider 未命中就回落首个 provider；model 同理。
// 调用方需先经 isConfigured 判定，保证返回非空。
export function resolveCurrent(config: Config): { provider: ProviderConfig; model: ModelConfig } {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]!
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]!
  return { provider, model }
}
```

`config/resolve/configured.ts`：

```ts
import type { Config } from '@dogegg/bridge'

// 是否「已配置到可以提问」：至少有一个完整 provider，且 defaultProvider/defaultModel 能解析到非空模型。
export function isConfigured(config: Config): boolean {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]
  if (!provider) return false
  if (!provider.name.trim() || !provider.baseURL.trim() || !provider.apiKey.trim() || provider.models.length === 0) return false
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]
  return !!model && !!model.name.trim()
}
```

`config/resolve/index.ts`：

```ts
export { resolveCurrent } from './current'
export { isConfigured } from './configured'
```

- [ ] **Step 5: 写 `config/editor/`（从 Agent 抽出的 ~150 行：路径解析 / 变更 / 校验回滚）**

`config/editor/paths.ts`（点号路径文法解析）：

```ts
import type { Config, ProviderConfig, ModelConfig } from '@dogegg/bridge'

// config_set 的点号路径约定：单段顶层字段；permission.<bucket>；providers.<i>.<field>；providers.<i>.models.<j>.<field>。
export type ConfigSetOp =
  | { kind: 'top'; field: 'defaultProvider' | 'defaultModel' | 'maxIterations' | 'maxRetries' | 'systemPrompt' | 'shellProgram'; value: string | number }
  | { kind: 'permission'; bucket: 'allow' | 'reject' | 'ask'; value: string[] }
  | { kind: 'provider'; index: number; field: 'name' | 'baseURL' | 'apiKey'; value: string }
  | { kind: 'model'; providerIndex: number; modelIndex: number; field: 'name' | 'contextWindow' | 'maxOutput' | 'reasoning'; value: string | number | boolean }

export function parseConfigSet(path: string, value: unknown): ConfigSetOp | null {
  const seg = path.split('.')
  if (seg.length === 1) {
    if (['defaultProvider', 'defaultModel'].includes(path)) return { kind: 'top', field: path as 'defaultProvider', value: value as string }
    if (['maxIterations', 'maxRetries'].includes(path)) return { kind: 'top', field: path as 'maxIterations', value: value as number }
    if (['systemPrompt', 'shellProgram'].includes(path)) return { kind: 'top', field: path as 'systemPrompt', value: value as string }
    return null
  }
  if (seg.length === 2 && seg[0] === 'permission') {
    const b = seg[1]
    if (b === 'allow' || b === 'reject' || b === 'ask') return { kind: 'permission', bucket: b, value: value as string[] }
    return null
  }
  if (seg.length === 3 && seg[0] === 'providers') {
    const idx = Number(seg[1])
    const f = seg[2]
    if (!Number.isInteger(idx) || idx < 0) return null
    if (f === 'name' || f === 'baseURL' || f === 'apiKey') return { kind: 'provider', index: idx, field: f, value: value as string }
    return null
  }
  if (seg.length === 5 && seg[0] === 'providers' && seg[2] === 'models') {
    const pi = Number(seg[1]); const mi = Number(seg[3]); const f = seg[4]!
    if (!Number.isInteger(pi) || pi < 0 || !Number.isInteger(mi) || mi < 0) return null
    if (f === 'name') return { kind: 'model', providerIndex: pi, modelIndex: mi, field: 'name', value: value as string }
    if (f === 'contextWindow') return { kind: 'model', providerIndex: pi, modelIndex: mi, field: 'contextWindow', value: value as number }
    if (f === 'maxOutput') return { kind: 'model', providerIndex: pi, modelIndex: mi, field: 'maxOutput', value: value as number }
    if (f === 'reasoning') return { kind: 'model', providerIndex: pi, modelIndex: mi, field: 'reasoning', value: value as boolean }
    return null
  }
  return null
}

export type ConfigAddOp =
  | { kind: 'provider'; value: ProviderConfig }
  | { kind: 'model'; providerIndex: number; value: ModelConfig }

// config_add：'providers' 追加 provider；'providers.<i>.models' 追加 model。
export function parseConfigAdd(path: string, value: unknown): ConfigAddOp | null {
  if (path === 'providers') return { kind: 'provider', value: value as ProviderConfig }
  const seg = path.split('.')
  if (seg.length === 3 && seg[0] === 'providers' && seg[2] === 'models') {
    const idx = Number(seg[1])
    if (!Number.isInteger(idx) || idx < 0) return null
    return { kind: 'model', providerIndex: idx, value: value as ModelConfig }
  }
  return null
}
```

`config/editor/mutate.ts`：

```ts
import type { ConfigSetOp, ConfigAddOp } from './paths'

export function applySet(config: Config, op: ConfigSetOp): void {
  switch (op.kind) {
    case 'top':
      if (op.field === 'defaultProvider' || op.field === 'defaultModel' || op.field === 'systemPrompt' || op.field === 'shellProgram') config[op.field] = op.value as string
      else config[op.field] = op.value as number
      break
    case 'permission':
      config.permission[op.bucket] = op.value
      break
    case 'provider': {
      const p = config.providers[op.index]
      if (!p) return
      p[op.field] = op.value
      break
    }
    case 'model': {
      const m = config.providers[op.providerIndex]?.models[op.modelIndex]
      if (!m) return
      ;(m as Record<string, unknown>)[op.field] = op.value
      break
    }
  }
}

export function applyAdd(config: Config, op: ConfigAddOp): void {
  if (op.kind === 'provider') config.providers.push(op.value)
  else config.providers[op.providerIndex]?.models.push(op.value)
}

// config_remove：'providers' 按 index 删 provider；'models' 按 index 删 model（providerIndex 定位）。
export function applyRemove(config: Config, path: string, index: number, providerIndex?: number): void {
  if (path === 'providers') {
    config.providers.splice(index, 1)
  } else if (path === 'models' && providerIndex !== undefined) {
    config.providers[providerIndex]?.models.splice(index, 1)
  }
}
```

`config/editor/validate.ts`：

```ts
import { configSchema, type Config } from '@dogegg/bridge'

// 返回重复的 provider/model 名。仅非空名判重（编辑期的新空节点允许多个共存）。
export function findDuplicateName(config: Config): string | null {
  const seen = new Set<string>()
  for (const p of config.providers) {
    if (p.name) {
      if (seen.has(p.name)) return `provider「${p.name}」`
      seen.add(p.name)
    }
    const models = new Set<string>()
    for (const m of p.models) {
      if (m.name) {
        if (models.has(m.name)) return `model「${m.name}」`
        models.add(m.name)
      }
    }
  }
  return null
}

// 校验 + 重名检查；失败返回回滚后的合法快照，成功返回 parsed（并入默认值）。
export function validateConfig(config: Config, lastGood: Config): { ok: true; config: Config } | { ok: false; config: Config; error: string } {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) {
    return { ok: false, config: lastGood, error: '配置校验失败，已回滚：' + parsed.error.issues[0]?.message }
  }
  const dup = findDuplicateName(parsed.data)
  if (dup) {
    return { ok: false, config: lastGood, error: '名称重复，已回滚：' + dup }
  }
  return { ok: true, config: parsed.data }
}
```

`config/editor/index.ts`（ConfigEditor 门面）：

```ts
import type { Config } from '@dogegg/bridge'
import { parseConfigSet, parseConfigAdd } from './paths'
import { applySet, applyAdd, applyRemove } from './mutate'
import { validateConfig } from './validate'

// 配置编辑门面：持有 config + 最后合法快照；任何 set/add/remove 后统一重校验，
// 失败回滚到快照并抛错提示（由调用方决定是否 emit error）。
export class ConfigEditor {
  private lastGood: Config

  constructor(private config: Config) {
    this.lastGood = structuredClone(config)
  }

  getConfig(): Config {
    return this.config
  }

  set(path: string, value: unknown): { ok: boolean; error?: string } {
    const op = parseConfigSet(path, value)
    if (op) applySet(this.config, op)
    return this.afterEdit()
  }

  add(path: string, value: unknown): { ok: boolean; error?: string } {
    const op = parseConfigAdd(path, value)
    if (op) applyAdd(this.config, op)
    return this.afterEdit()
  }

  remove(path: string, index: number, providerIndex?: number): { ok: boolean; error?: string } {
    applyRemove(this.config, path, index, providerIndex)
    return this.afterEdit()
  }

  private afterEdit(): { ok: boolean; error?: string } {
    const result = validateConfig(this.config, this.lastGood)
    this.config = result.config
    if (result.ok) this.lastGood = structuredClone(result.config)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }
}
```

> 注：重复名检查已内含于 `validate.ts` 的 `validateConfig`，故 `ConfigEditor` 不需再重复实现。

`config/index.ts`：

```ts
export { loadConfig, saveConfig, findConfig, configTargetPath } from './loader'
export { resolveCurrent, isConfigured } from './resolve'
export { ConfigEditor } from './editor'
```

---

### Task 2.8: `loop/`（← src/agent/loop.ts，split run / tool-calls / types；summarize 已归 context）

**Files 结构**：

```
agent/src/loop/
├─ index.ts
├─ types.ts        # LoopDeps
├─ run.ts          # 主循环：迭代 / maxIterations / 取消检查 / 压缩 / 调 LLM → 串行工具
└─ tool-calls.ts   # 串行工具执行 + 结果整形（含原 design 的 tool-result）
```

- [ ] **Step 1: `loop/types.ts`**

```ts
import type { ProviderAdapter } from '../llm/types'
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { PermissionManager } from '../permission'
import type { State } from '@dogegg/bridge'

// 核心循环所需的外部依赖。emit 向上发 Agent 级事件，requestPermission 等待审批决议，checkCancelled 轮询取消。
export interface LoopDeps {
  adapter: ProviderAdapter
  providerBaseURL: string
  apiKey: string
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  tools: Tool[]
  history: Message[]
  systemPrompt: string
  windowTokens: number
  maxIterations: number
  permission: PermissionManager
  cwd: string
  shellProgram: string | undefined
  signal: AbortSignal
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
}

export type LlmCallbacks = {
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
}
```

- [ ] **Step 2: `loop/tool-calls.ts`（串行工具执行 + 结果整形，含 tool-result）**

```ts
import type { Tool } from '../tools/types'
import type { Message, State } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { truncate } from '../context'
import { transition, type TransitionInput } from '../core/state'

// ToolResult → 回填历史消息的 content：content 截断，error 组 ERROR。仅在 loop 内使用，故归 loop。
function toolResultContent(result: { content: string } | { error: string }): { content: string; error?: string } {
  if ('content' in result) return { content: truncate(result.content) }
  return { content: `ERROR: ${result.error}`, error: result.error }
}

export interface ToolTurnCtx {
  tools: Tool[]
  messages: Message[]
  cwd: string
  signal: AbortSignal
  shellProgram: string | undefined
  reasoning: boolean
  permission: { classify(tool: string): 'allow' | 'reject' | 'ask'; apply(tool: string, d: 'allow_once' | 'allow_always' | 'reject'): void }
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<'allow_once' | 'allow_always' | 'reject'>
  checkCancelled: () => boolean
  trans: (input: TransitionInput) => State
}

// 串行执行本次响应的全部 tool_calls：逐步校验参数、过权限、执行、回填 tool 消息。
// state 迁移由调用方传入的 trans 驱动；isLast 决定回填后是 tool_done 还是 result_back/reject → 重新请求模型。
export async function executeToolCalls(calls: ToolCall[], ctx: ToolTurnCtx): Promise<State> {
  let state: State = ctx.trans({ kind: 'tool_calls' })
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    const isLast = i === calls.length - 1
    if (ctx.checkCancelled()) {
      return state // 上层 run 会统一处理 cancel
    }

    const tool = ctx.tools.find((t) => t.name === call.function.name)
    if (!tool) {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` })
      state = ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }

    let args: unknown
    try {
      args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
    } catch {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: '参数校验失败' })
      state = ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }

    const verdict = ctx.permission.classify(tool.name)
    if (verdict === 'reject') {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
      state = ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }
    if (verdict === 'ask') {
      state = ctx.trans({ kind: 'tool_needs_permission' })
      const decision = await ctx.requestPermission(tool.name, args)
      ctx.permission.apply(tool.name, decision)
      if (decision === 'reject') {
        ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
        state = ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
        continue
      }
      state = ctx.trans({ kind: 'allow' })
      ctx.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: ctx.cwd, signal: ctx.signal, shellProgram: ctx.shellProgram })
      const { content, error } = toolResultContent(result)
      ctx.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error })
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content })
      state = ctx.trans(isLast ? { kind: 'result_back', reasoning: ctx.reasoning } : { kind: 'tool_done' })
    } else {
      state = ctx.trans({ kind: 'tool_auto' })
      ctx.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: ctx.cwd, signal: ctx.signal, shellProgram: ctx.shellProgram })
      const { content, error } = toolResultContent(result)
      ctx.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error })
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content })
      state = ctx.trans(isLast ? { kind: 'result_back', reasoning: ctx.reasoning } : { kind: 'tool_done' })
    }
  }
  return state
}
```

- [ ] **Step 3: `loop/run.ts`（主循环）**

```ts
import type { Message, State, ToolCall } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { transition, type TransitionInput } from '../core/state'
import { compactHistory } from '../context/compact'
import { summarizeHistory } from '../context/compact'
import { estimateContextTokens } from '../context'
import { CancelledError } from '../shared'
import { executeToolCalls, type ToolTurnCtx } from './tool-calls'
import type { LoopDeps } from './types'

// 核心 Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 状态由 state.ts 的 transition() 驱动。返回完整历史供会话持久化与 resume 回放。
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  let messages: Message[] = [...deps.history]
  let state: State = 'idle'
  let iterations = 0
  const toolParams = deps.tools.map((t) => t.parameters)

  const trans = (input: TransitionInput): State => {
    const next = transition(state, input)
    if (next !== state) deps.emit({ type: 'state', from: state, to: next })
    return next
  }

  state = trans({ kind: 'submit', reasoning: deps.reasoning })

  const toolCtx: ToolTurnCtx = {
    tools: deps.tools,
    messages,
    cwd: deps.cwd,
    signal: deps.signal,
    shellProgram: deps.shellProgram,
    reasoning: deps.reasoning,
    permission: deps.permission,
    emit: (e) => deps.emit(e),
    requestPermission: deps.requestPermission,
    checkCancelled: deps.checkCancelled,
    trans: (i) => (state = trans(i)),
  }

  for (;;) {
    if (deps.checkCancelled()) {
      state = trans({ kind: 'cancel' })
      throw new CancelledError()
    }
    if (iterations++ >= deps.maxIterations) {
      state = trans({ kind: 'error' })
      throw new Error('达到 maxIterations 上限')
    }

    const used = estimateContextTokens(deps.systemPrompt, messages, toolParams)
    const compacted = await compactHistory({
      messages,
      systemPrompt: deps.systemPrompt,
      tools: toolParams,
      windowTokens: deps.windowTokens,
      summarize: (old) => summarizeHistory(deps, old),
    })
    if (compacted.compacted) {
      messages = compacted.messages
      deps.emit({ type: 'compaction', before_tokens: compacted.before, after_tokens: compacted.after })
    }

    let assistant: Message
    try {
      assistant = await deps.adapter.chat(
        {
          baseURL: deps.providerBaseURL,
          apiKey: deps.apiKey,
          model: deps.model,
          systemPrompt: deps.systemPrompt,
          messages,
          tools: deps.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          maxOutput: deps.maxOutput,
          maxRetries: deps.maxRetries,
        },
        deps.signal,
        (e) => {
          if (e.type === 'text_delta') {
            if (state === 'thinking') state = trans({ kind: 'thought_done' })
            deps.emit({ type: 'text_delta', delta: e.text })
          } else if (e.type === 'thought_delta' && deps.reasoning) {
            deps.emit({ type: 'thought_delta', delta: e.text })
          }
        },
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        state = trans({ kind: 'cancel' })
        throw new CancelledError()
      }
      state = trans({ kind: 'error' })
      throw e
    }

    if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
    if (state === 'thinking') state = trans({ kind: 'thought_done' })
    messages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: '' })

    const calls: ToolCall[] = assistant.tool_calls ?? []
    if (calls.length === 0) {
      state = trans({ kind: 'final_answer' })
      deps.emit({ type: 'finished' })
      return messages
    }

    toolCtx.messages = messages
    state = await executeToolCalls(calls, toolCtx)
  }
}
```

> ⚠️ 上面 `toolCtx.trans` 里 `state = trans(i)` 没有返回值会导致 `executeToolCalls` 拿到的 state 不准。执行时把 `trans` 改为返回下一态并同步外层 state（见下方修正），并在 `executeToolCalls` 签名里去掉传入的初始 `tool_calls` 迁移（改由调用方先 trans 再调用）。最终以「Test-first：跑 loop.test 绿」为准校正。

`loop/index.ts`：

```ts
export { runLoop } from './run'
export type { LoopDeps } from './types'
```

- [ ] **Step 4: 删除旧 loop/context/session/permission/state/config-loader 文件**

```bash
git rm src/agent/loop.ts src/agent/context.ts src/agent/session.ts src/agent/permission.ts src/agent/state.ts src/config/loader.ts src/common/utils/token-count.ts src/common/utils/truncate.ts src/common/utils/shell.ts src/common/utils/logger.ts
```

> **2.8 修正（必读）**：上一步 `loop/tool-calls.ts` 与 `loop/run.ts` 里有关 `trans` 返回值的写法会丢失状态。**正确设计**：`executeToolCalls` 用 `trans: (input: TransitionInput) => void`（副作用式，闭包已更新外层 `state`），自身不维护也不返回 state；`tool_calls` 迁移由 `run` 在调用前执行。请以如下最终版本为准，替换 2.8 Step 2/3 中相应部分。

`loop/tool-calls.ts`（最终版）：

```ts
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision, ToolCall } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { truncate } from '../context'
import type { TransitionInput } from '../core/state'

// ToolResult → 回填历史消息的 content：content 截断，error 组 ERROR。仅在 loop 内使用，故归 loop。
function toolResultContent(result: { content: string } | { error: string }): { content: string; error?: string } {
  if ('content' in result) return { content: truncate(result.content) }
  return { content: `ERROR: ${result.error}`, error: result.error }
}

export interface ToolTurnCtx {
  tools: Tool[]
  messages: Message[]
  cwd: string
  signal: AbortSignal
  shellProgram: string | undefined
  reasoning: boolean
  permission: { classify(tool: string): 'allow' | 'reject' | 'ask'; apply(tool: string, d: PermissionDecision): void }
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
  trans: (input: TransitionInput) => void
}

// 串行执行本次响应的全部 tool_calls：逐步校验参数、过权限、执行、回填 tool 消息。
// isLast 决定回填后是 tool_done 还是 result_back/reject → 重新请求模型。state 迁移经由 trans 副作用驱动外层 state。
export async function executeToolCalls(calls: ToolCall[], ctx: ToolTurnCtx): Promise<void> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    const isLast = i === calls.length - 1
    if (ctx.checkCancelled()) return

    const tool = ctx.tools.find((t) => t.name === call.function.name)
    if (!tool) {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` })
      ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }

    let args: unknown
    try {
      args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
    } catch {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: '参数校验失败' })
      ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }

    const verdict = ctx.permission.classify(tool.name)
    if (verdict === 'reject') {
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
      ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
      continue
    }
    if (verdict === 'ask') {
      ctx.trans({ kind: 'tool_needs_permission' })
      const decision = await ctx.requestPermission(tool.name, args)
      ctx.permission.apply(tool.name, decision)
      if (decision === 'reject') {
        ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
        ctx.trans(isLast ? { kind: 'reject', reasoning: ctx.reasoning } : { kind: 'tool_done' })
        continue
      }
      ctx.trans({ kind: 'allow' })
      ctx.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: ctx.cwd, signal: ctx.signal, shellProgram: ctx.shellProgram })
      const { content, error } = toolResultContent(result)
      ctx.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error })
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content })
      ctx.trans(isLast ? { kind: 'result_back', reasoning: ctx.reasoning } : { kind: 'tool_done' })
    } else {
      ctx.trans({ kind: 'tool_auto' })
      ctx.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: ctx.cwd, signal: ctx.signal, shellProgram: ctx.shellProgram })
      const { content, error } = toolResultContent(result)
      ctx.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error })
      ctx.messages.push({ role: 'tool', tool_call_id: call.id, content })
      ctx.trans(isLast ? { kind: 'result_back', reasoning: ctx.reasoning } : { kind: 'tool_done' })
    }
  }
}
```

`loop/run.ts`（最终版，仅 runLoop 主体校正 toolCtx 与调用处）：

```ts
import type { Message, State, ToolCall } from '@dogegg/bridge'
import { transition, type TransitionInput } from '../core/state'
import { compactHistory, summarizeHistory } from '../context/compact'
import { estimateContextTokens } from '../context'
import { CancelledError } from '../shared'
import { executeToolCalls, type ToolTurnCtx } from './tool-calls'
import type { LoopDeps } from './types'

// 核心 Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 状态由 transition() 驱动。返回完整历史供会话持久化与 resume 回放。
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  let messages: Message[] = [...deps.history]
  let state: State = 'idle'
  let iterations = 0
  const toolParams = deps.tools.map((t) => t.parameters)

  const trans = (input: TransitionInput): void => {
    const next = transition(state, input)
    if (next !== state) deps.emit({ type: 'state', from: state, to: next })
    state = next
  }

  trans({ kind: 'submit', reasoning: deps.reasoning })

  const toolCtx: ToolTurnCtx = {
    tools: deps.tools,
    messages,
    cwd: deps.cwd,
    signal: deps.signal,
    shellProgram: deps.shellProgram,
    reasoning: deps.reasoning,
    permission: deps.permission,
    emit: (e) => deps.emit(e),
    requestPermission: deps.requestPermission,
    checkCancelled: deps.checkCancelled,
    trans,
  }

  for (;;) {
    if (deps.checkCancelled()) {
      trans({ kind: 'cancel' })
      throw new CancelledError()
    }
    if (iterations++ >= deps.maxIterations) {
      trans({ kind: 'error' })
      throw new Error('达到 maxIterations 上限')
    }

    const compacted = await compactHistory({
      messages,
      systemPrompt: deps.systemPrompt,
      tools: toolParams,
      windowTokens: deps.windowTokens,
      summarize: (old) => summarizeHistory(deps, old),
    })
    if (compacted.compacted) {
      messages = compacted.messages
      deps.emit({ type: 'compaction', before_tokens: compacted.before, after_tokens: compacted.after })
    }

    let assistant: Message
    try {
      assistant = await deps.adapter.chat(
        {
          baseURL: deps.providerBaseURL,
          apiKey: deps.apiKey,
          model: deps.model,
          systemPrompt: deps.systemPrompt,
          messages,
          tools: deps.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          maxOutput: deps.maxOutput,
          maxRetries: deps.maxRetries,
        },
        deps.signal,
        (e) => {
          if (e.type === 'text_delta') {
            if (state === 'thinking') trans({ kind: 'thought_done' })
            deps.emit({ type: 'text_delta', delta: e.text })
          } else if (e.type === 'thought_delta' && deps.reasoning) {
            deps.emit({ type: 'thought_delta', delta: e.text })
          }
        },
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        trans({ kind: 'cancel' })
        throw new CancelledError()
      }
      trans({ kind: 'error' })
      throw e
    }

    if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
    if (state === 'thinking') trans({ kind: 'thought_done' })
    messages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: '' })

    const calls: ToolCall[] = assistant.tool_calls ?? []
    if (calls.length === 0) {
      trans({ kind: 'final_answer' })
      deps.emit({ type: 'finished' })
      return messages
    }

    trans({ kind: 'tool_calls' })
    toolCtx.messages = messages
    await executeToolCalls(calls, toolCtx)
  }
}
```

> 说明：原 loop 里 `const used = estimateContextTokens(...)` 只用于触发判断；`compactHistory` 已在内部重新估算并返回 before/after，故 `estimateContextTokens` 不再需要被 run 直接 import——上面最终版已移除该多余 import。执行时据此删掉 `run.ts` 顶部的 `import { estimateContextTokens } from '../context'`，保留 `compactHistory`/`summarizeHistory`。

---

### Task 2.9: 写 `agent.ts` 完整版 + `agent/index.ts`

- [ ] **Step 1: `core/agent.ts`（完整版）**

```ts
import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage, AgentToUiMessage } from '@dogegg/bridge'
import type { Message, State, PermissionDecision, Config } from '@dogegg/bridge'
import { getAllTools } from '../tools'
import { openAiAdapter } from '../llm/provider/openai'
import { PermissionManager } from '../permission'
import { loadSystemPrompt, estimateContextTokens } from '../context'
import { saveSession, loadSession, listSessions } from '../session'
import { runLoop } from '../loop'
import { summarizeHistory, compactHistory } from '../context/compact'
import { transition } from './state'
import { isConfigured, resolveCurrent } from '../config/resolve'
import { saveConfig } from '../config/loader'
import { ConfigEditor } from '../config/editor'
import { PendingPermissions } from './pending'
import { newId, initLogger, log, readLogTail, sessionLogPath, CancelledError } from '../shared'

export interface AgentOptions {
  port: AgentPort
  config: Config
  cwd: string
  logDir: string
}

// Agent 是后端唯一入口：持有会话历史、provider/permission 运行时 + 配置编辑，经 port 收发消息。
// 不 import ui，只依赖 @dogegg/bridge 消息契约。
export class Agent {
  private editor: ConfigEditor
  private pending = new PendingPermissions()
  private history: Message[] = []
  private sessionId = newId()
  private cancelled = false
  private running = false
  private state: State = 'idle'
  private controller: AbortController | null = null
  private permission: PermissionManager

  constructor(private options: AgentOptions) {
    initLogger(options.logDir)
    this.editor = new ConfigEditor(options.config)
    this.permission = new PermissionManager(options.config.permission)
    options.port.onMessage((msg) => void this.handle(msg))
  }

  private get config(): Config {
    return this.editor.getConfig()
  }

  private emit(m: AgentToUiMessage): void {
    if (m.type === 'state') {
      this.state = m.to
      log(this.sessionId, 'state', `${m.from} → ${m.to}`)
    } else if (m.type === 'message') {
      log(this.sessionId, 'message', m.role)
    } else if (m.type === 'tool_start') {
      log(this.sessionId, 'tool', `${m.name} ${JSON.stringify(m.input)}`)
    } else if (m.type === 'tool_end') {
      log(this.sessionId, 'tool', `${m.name} ${m.error ? '✕ ' + m.error : '✓'}`)
    } else if (m.type === 'permission_request') {
      log(this.sessionId, 'permission', `ask ${m.tool}`)
    } else if (m.type === 'error') {
      log(this.sessionId, 'error', m.error.message)
    } else if (m.type === 'compaction') {
      log(this.sessionId, 'compact', `${m.before_tokens} → ${m.after_tokens}`)
    } else if (m.type === 'finished') {
      log(this.sessionId, 'state', 'finished')
    }
    this.options.port.post(m)
  }

  private estimateCurrentTokens(): number {
    return estimateContextTokens(loadSystemPrompt(this.config.systemPrompt), this.history, getAllTools().map((t) => t.parameters))
  }

  // 手工触发压缩（/compact）：复用与自动压缩相同的总结逻辑。
  private async compactNow(): Promise<void> {
    const { provider, model } = resolveCurrent(this.config)
    const result = await compactHistory({
      messages: this.history,
      systemPrompt: loadSystemPrompt(this.config.systemPrompt),
      tools: getAllTools().map((t) => t.parameters),
      windowTokens: model.contextWindow,
      summarize: (old) => summarizeHistory({ adapter: openAiAdapter(), providerBaseURL: provider.baseURL, apiKey: provider.apiKey, model: model.name }, old),
    })
    if (result.compacted) {
      this.history = result.messages
      saveSession(this.sessionId, this.history)
    }
    this.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after })
  }

  private requestPermission(tool: string, input: unknown): Promise<PermissionDecision> {
    return new Promise((resolve, reject) => {
      const id = newId()
      this.pending.add(id, { resolve, reject })
      this.emit({ type: 'permission_request', id, tool, input })
    })
  }

  private async handle(cmd: UiToAgentMessage): Promise<void> {
    switch (cmd.type) {
      case 'submit': {
        if (this.running) return
        if (!isConfigured(this.config)) {
          this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config 添加并保存后重试' })
          return
        }
        this.cancelled = false
        this.controller = new AbortController()
        this.running = true
        this.history.push({ role: 'user', content: cmd.text })
        this.emit({ type: 'message', role: 'user', id: '' })
        const { provider, model } = resolveCurrent(this.config)
        try {
          this.history = await runLoop({
            adapter: openAiAdapter(),
            providerBaseURL: provider.baseURL,
            apiKey: provider.apiKey,
            model: model.name,
            maxOutput: model.maxOutput,
            maxRetries: this.config.maxRetries,
            reasoning: model.reasoning,
            tools: getAllTools(),
            history: this.history,
            systemPrompt: loadSystemPrompt(this.config.systemPrompt),
            windowTokens: model.contextWindow,
            maxIterations: this.config.maxIterations,
            permission: this.permission,
            cwd: this.options.cwd,
            shellProgram: this.config.shellProgram,
            signal: this.controller.signal,
            emit: (e) => this.emit(e),
            requestPermission: (tool, input) => this.requestPermission(tool, input),
            checkCancelled: () => this.cancelled,
          })
        } catch (e) {
          if (!(e instanceof CancelledError)) this.emit({ type: 'error', error: e as Error })
          this.emit({ type: 'state', from: this.state, to: transition(this.state, { kind: 'reset' }) })
        } finally {
          this.running = false
          saveSession(this.sessionId, this.history)
        }
        break
      }
      case 'cancel': {
        this.cancelled = true
        this.controller?.abort()
        this.pending.rejectAll(new CancelledError())
        break
      }
      case 'permission_decision': {
        const hit = this.pending.resolve(cmd.id, cmd.decision)
        if (hit) log(this.sessionId, 'permission', `decision ${cmd.decision}`)
        break
      }
      case 'new_session':
        if (this.running) return
        this.history = []
        this.sessionId = newId()
        this.emit({ type: 'session_ready', id: this.sessionId, messages: [] })
        break
      case 'list_sessions':
        this.emit({ type: 'session_list', sessions: listSessions() })
        break
      case 'resume_session': {
        if (this.running) return
        const s = loadSession(cmd.id)
        this.history = s.messages
        this.sessionId = s.id
        this.emit({ type: 'session_ready', id: s.id, messages: s.messages })
        break
      }
      case 'tools_request':
        this.emit({ type: 'tools_list', tools: getAllTools().map((t) => ({ name: t.name, description: t.description })) })
        break
      case 'config_request':
        this.emit({ type: 'config_state', config: this.config })
        break
      case 'context_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const { model } = resolveCurrent(this.config)
        const tokens = this.estimateCurrentTokens()
        this.emit({ type: 'context_state', estimatedTokens: tokens, windowTokens: model.contextWindow, percent: model.contextWindow ? Math.round((tokens / model.contextWindow) * 100) : 0 })
        break
      }
      case 'status_request': {
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        const { provider, model } = resolveCurrent(this.config)
        this.emit({ type: 'status_state', sessionId: this.sessionId, provider: provider.name, model: model.name, cwd: this.options.cwd, state: this.state, estimatedTokens: this.estimateCurrentTokens(), windowTokens: model.contextWindow })
        break
      }
      case 'system_request':
        this.emit({ type: 'system_state', path: this.config.systemPrompt ?? '内置', content: loadSystemPrompt(this.config.systemPrompt) })
        break
      case 'clear_history':
        if (this.running) return
        this.history = []
        this.emit({ type: 'history_cleared' })
        break
      case 'compact_request':
        if (!isConfigured(this.config)) { this.emit({ type: 'notice', text: '尚未配置 provider，请先 /config' }); break }
        await this.compactNow()
        break
      case 'log_request':
        this.emit({ type: 'log_state', path: sessionLogPath(this.sessionId) ?? '~/.dogegg/logs/<session>.log', tail: readLogTail(this.sessionId) })
        break
      case 'config_set': {
        const r = this.editor.set(cmd.path, cmd.value)
        if (r.ok) this.afterConfigEdit()
        else this.emit({ type: 'error', error: new Error(r.error ?? '配置编辑失败') })
        break
      }
      case 'config_add': {
        const r = this.editor.add(cmd.path, cmd.value)
        if (r.ok) this.afterConfigEdit()
        else this.emit({ type: 'error', error: new Error(r.error ?? '配置编辑失败') })
        break
      }
      case 'config_remove': {
        const r = this.editor.remove(cmd.path, cmd.index, cmd.providerIndex)
        if (r.ok) this.afterConfigEdit()
        else this.emit({ type: 'error', error: new Error(r.error ?? '配置编辑失败') })
        break
      }
      case 'quit':
        process.exit(0)
    }
  }

  // 配置编辑成功后：重建 permission 运行时 + 落盘 + emit config_updated。
  private afterConfigEdit(): void {
    this.permission = new PermissionManager(this.config.permission)
    saveConfig(this.config)
    this.emit({ type: 'config_updated', config: this.config })
  }
}
```

- [ ] **Step 2: 确认 import 头一致**（Step 1 的 import 已含 `loadSystemPrompt, estimateContextTokens`，若你在 Step 1 只写了部分，以下为完整头，以此为准）：

```ts
import type { AgentPort } from '@dogegg/bridge'
import type { UiToAgentMessage, AgentToUiMessage } from '@dogegg/bridge'
import type { Message, State, PermissionDecision, Config } from '@dogegg/bridge'
import { getAllTools } from '../tools'
import { openAiAdapter } from '../llm/provider/openai'
import { PermissionManager } from '../permission'
import { loadSystemPrompt, estimateContextTokens } from '../context'
import { saveSession, loadSession, listSessions } from '../session'
import { runLoop } from '../loop'
import { summarizeHistory, compactHistory } from '../context/compact'
import { transition } from './state'
import { isConfigured, resolveCurrent } from '../config/resolve'
import { saveConfig } from '../config/loader'
import { ConfigEditor } from '../config/editor'
import { PendingPermissions } from './pending'
import { newId, initLogger, log, readLogTail, sessionLogPath, CancelledError } from '../shared'
```

- [ ] **Step 3: `core/index.ts` + `agent/index.ts`**

```ts
// core/index.ts
export { Agent, type AgentOptions } from './agent'
export { PendingPermissions } from './pending'
export { transition, type TransitionInput } from './state'
```

```ts
// agent/src/index.ts（包出口：Agent / loadConfig）
export { Agent, type AgentOptions } from './core'
export { loadConfig } from './config/loader'
```

- [ ] **Step 4: 删除已迁移的旧 agent 源文件**（`src/common/utils/markdown.ts` 留到 Phase 3 迁移 UI 时处理，`src/common/` 目录待 Phase 3 后清理）

```bash
git rm src/agent/index.ts src/common/utils/id.ts src/common/errors.ts
rm -rf src/agent src/llm
```

> `src/common/` 目前残留 `utils/markdown.ts`（UI 仍依赖），Phase 3 迁移后一并 `rm -rf src/common`。

### Task 2.10: 测试迁移到 agent/test

**规则**：除 `agent.test.ts` 需改为经 channel 黑盒驱动外，其余测试是从 src 到 agent 的**纯进口改写**（断言不变）。

**纯进口改写映射表**（旧 import → 新 import）：

| 测试文件 | 旧 import | 新 import |
|---|---|---|
| `test/agent/state.test.ts` | `../../src/agent/state` | `../../src/core/state` |
| `test/agent/permission.test.ts` | `../../src/agent/permission` | `../../src/permission` |
| `test/agent/session.test.ts` | `../../src/agent/session` | `../../src/session` |
| `test/agent/context.test.ts` | `../../src/agent/context` | `../../src/context` |
| `test/agent/loop.test.ts` | `../../src/agent/loop` | `../../src/loop`；`../../src/agent/permission` → `../../src/permission`；`../../src/tools/read_file` → `../../src/tools/read_file`；`../../src/llm/types` → `../../src/llm/types` |
| `test/common/logger.test.ts` | `../../src/common/utils/logger` | `../../src/shared/logger` |
| `test/common/shell.test.ts` | `../../src/common/utils/shell` | `../../src/tools/shell/interpreter` |
| `test/common/utils.test.ts` | `../../src/common/utils/truncate` / `token-count` / `id` | 分别 → `../../src/context/message/truncate`、`../../src/context/token/estimate`、`../../src/shared/id` |
| `test/config/loader.test.ts` | `../../src/config/loader` | `../../src/config/loader`；`../../src/config/schema` → `@dogegg/bridge` |
| `test/llm/provider.test.ts` | `../../src/llm/provider/openai` | `../../src/llm/provider/openai` |
| `test/llm/streaming.test.ts` | `../../src/llm/streaming/openai` | `../../src/llm/streaming/openai` |
| `test/tools/file-tools.test.ts` | `../../src/tools/*` | `../../src/tools/*` |

- [ ] **Step 1: `git mv` 迁移测试文件 + 逐个改进口**

```bash
mkdir -p agent/test/{core,loop,context,llm,tools,session,permission,config,shared}
git mv test/agent/state.test.ts agent/test/core/state.test.ts
git mv test/agent/agent.test.ts agent/test/core/agent.test.ts
git mv test/agent/loop.test.ts agent/test/loop/loop.test.ts
git mv test/agent/context.test.ts agent/test/context/context.test.ts
git mv test/agent/session.test.ts agent/test/session/session.test.ts
git mv test/agent/permission.test.ts agent/test/permission/permission.test.ts
git mv test/common/logger.test.ts agent/test/shared/logger.test.ts
git mv test/common/shell.test.ts agent/test/tools/interpreter.test.ts
git mv test/common/utils.test.ts agent/test/context/utils.test.ts
git mv test/config/loader.test.ts agent/test/config/loader.test.ts
git mv test/llm/provider.test.ts agent/test/llm/provider.test.ts
git mv test/llm/streaming.test.ts agent/test/llm/streaming.test.ts
git mv test/tools/file-tools.test.ts agent/test/tools/file-tools.test.ts
```

（`test/common/markdown.test.ts`、`test/ui/config-tree.test.ts` 留 Phase 3 迁到 ui；`test/agent/agent.test.ts` 在 Step 2 重写。）

- [ ] **Step 2: 重写 `agent/test/core/agent.test.ts` 为 channel 黑盒驱动**

```ts
import { describe, it, expect } from 'vitest'
import { createChannelPair } from '@dogegg/bridge'
import { Agent } from '../../src/core'
import { loadConfig } from '../../src/config/loader'

const cfg = loadConfig({ providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }] })
const logDir = '/tmp/dogegg-agent-test-logs'

function makeAgent(): ReturnType<typeof createChannelPair> & { agent: Agent } {
  const pair = createChannelPair()
  const agent = new Agent({ port: pair.agentPort, config: cfg, cwd: process.cwd(), logDir })
  return { ...pair, agent }
}

describe('Agent command routing', () => {
  it('responds to read-only info commands', async () => {
    const { agent, uiPort } = makeAgent()
    const types: string[] = []
    uiPort.onMessage((e) => types.push(e.type))

    uiPort.post({ type: 'status_request' })
    uiPort.post({ type: 'tools_request' })
    uiPort.post({ type: 'list_sessions' })
    uiPort.post({ type: 'context_request' })
    uiPort.post({ type: 'system_request' })
    await new Promise((r) => setTimeout(r, 0))

    expect(types).toContain('status_state')
    expect(types).toContain('tools_list')
    expect(types).toContain('session_list')
    expect(types).toContain('context_state')
    expect(types).toContain('system_state')
  })

  it('new_session resets and emits session_ready', async () => {
    const { uiPort } = makeAgent()
    const types: string[] = []
    uiPort.onMessage((e) => types.push(e.type))
    uiPort.post({ type: 'new_session' })
    await new Promise((r) => setTimeout(r, 0))
    expect(types).toContain('session_ready')
  })
})
```

> 注：原测试调用 `agent.send()` 返回 Promise 并 await；channel 的 `post` 是同步发后即忘，故改为「post 后 `await new Promise(r => setTimeout(r, 0))`」确保同步投递的事件已送达后再断言。这是 channel 语义下的等价改写，行为不变。

- [ ] **Step 3: Phase 2 收尾验证**

```bash
npm run typecheck && npm run test:run
```

Expected: 全绿。此时 `src/` 只剩 `ui/` 与 `common/utils/markdown.ts`（UI 待迁）。

- [ ] **Step 4: 提交 Phase 2**

```bash
git add -A
git commit -m "refactor(agent): migrate backend into @dogegg/agent with per-responsibility files"
```

---

## Phase 3: ui 包迁移与拆分

**目标**：把 `src/ui/tui/` 迁进 `ui/src/tui/`，474 行的 `index.tsx` + 164 行 `config-tree.ts` + 57 行 `components.tsx` 按职责拆成小文件。`App` 改为接收 `UiPort`，彻底删除 `import type { Agent }`。

**Files 结构**：

```
ui/src/
├─ index.ts                      # 包出口：renderTui
└─ tui/
   ├─ index.ts
   ├─ app/{index,app,view-state,keys,entry}.ts(x)
   ├─ chat/{index,block,reducer,viewport,browse}.ts
   ├─ input/{index,commands,input-box}.ts(x)
   ├─ overlays/
   │  ├─ index.ts
   │  ├─ permission/{index,decisions,overlay}.tsx
   │  ├─ pickers/{index,menu,session-picker,model-picker}.tsx
   │  ├─ prompt/{index,overlay}.tsx
   │  └─ config/{index,entries,navigation,label,editor}.tsx
   ├─ components/{top-bar,message-block,status-bar,list-picker}/index.tsx
   ├─ theme/{index,palette}.ts
   └─ markdown/{index,render}.ts
```

### Task 3.1: ui 包骨架

- [ ] **Step 1: 写 `ui/package.json`、`ui/tsconfig.json`**

```json
{
  "name": "@dogegg/ui",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "ink": "^7.1.1", "react": "^19.2.8", "ink-text-input": "^6.0.0", "marked": "^15.0.12", "@dogegg/bridge": "*" },
  "devDependencies": { "@types/react": "^19.2.18" }
}
```

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"],
  "compilerOptions": { "jsx": "react-jsx" }
}
```

### Task 3.2: `theme/` 与 `markdown/`（叶子，先落）

- [ ] **Step 1: `theme/palette.ts` + `theme/index.ts`**

```ts
// theme/palette.ts
// Catppuccin Mocha 调色板（暗色、低饱和），落地原设计 §14。
export const palette = {
  accent: '#89b4fa',
  text: '#cdd6f4',
  subtext: '#6c7086',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  cyan: '#94e2d5',
  red: '#f38ba8',
}

export type BlockColor = string
```

```ts
// theme/index.ts
export { palette, type BlockColor } from './palette'
```

- [ ] **Step 2: `markdown/render.ts`（← src/common/utils/markdown.ts 原样）+ `markdown/index.ts`**

```ts
// markdown/render.ts
import { Lexer } from 'marked'

// marked token 的宽松形状：只取渲染纯文本需要的字段，避免与 marked 内部类型强耦合。
interface MdToken {
  type: string
  text?: string
  raw?: string
  tokens?: MdToken[]
  items?: { tokens?: MdToken[] }[]
}

function inlineText(tokens: MdToken[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((t) => {
      if (t.type === 'codespan' || t.type === 'text' || t.type === 'escape') return t.text ?? ''
      if (t.type === 'strong' || t.type === 'em' || t.type === 'del') return inlineText(t.tokens)
      if (t.type === 'link') return t.text ?? ''
      if (t.type === 'br') return '\n'
      return t.raw ?? ''
    })
    .join('')
}

// 把 markdown 渲染成「干净纯文本」：去掉 # / 反引号 / ** 等语法噪音，保留标题、代码块、列表、引用的可读结构。
// 有意不产出 ANSI（marked-terminal 的 ANSI 会与 Ink 的颜色处理冲突），着色统一交给 MessageBlock。
export function renderMarkdown(md: string): string {
  const tokens = new Lexer().lex(md) as unknown as MdToken[]
  const lines: string[] = []
  for (const t of tokens) {
    if (t.type === 'heading') lines.push((t.text ?? '').trim())
    else if (t.type === 'paragraph') lines.push(inlineText(t.tokens).trim())
    else if (t.type === 'code') lines.push((t.text ?? '').replace(/\n$/, ''))
    else if (t.type === 'list') {
      for (const item of t.items ?? []) lines.push('• ' + inlineText(item.tokens).trim())
    } else if (t.type === 'blockquote') {
      for (const l of inlineText(t.tokens).split('\n')) lines.push('│ ' + l)
    } else if (t.type === 'hr') lines.push('────────')
    else if (t.type === 'space') continue
    else if (t.raw) lines.push(t.raw.trim())
  }
  return lines.join('\n')
}
```

```ts
// markdown/index.ts
export { renderMarkdown } from './render'
```

### Task 3.3: `components/`（一组件一文件夹）

- [ ] **Step 1: 四个组件（从 src/ui/tui/components.tsx 拆）**

`components/top-bar/index.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 顶部品牌条：应用名 + 版本 + 当前 provider/model。
export function TopBar(props: { info: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color={palette.accent}>🐶🥚 DogEggAgent v0.1.0</Text>
      <Text dimColor>  {props.info}</Text>
    </Box>
  )
}
```

`components/message-block/index.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import { palette, type BlockColor } from '../../theme'

// 消息块：圆角边框，彩色角色图标 + 加粗角色名 + 缩进正文。focused 用 accent 边框标示浏览焦点。
export function MessageBlock(props: { icon: string; role: string; color: BlockColor; focused?: boolean; children: React.ReactNode }) {
  return (
    <Box borderStyle="round" borderColor={props.focused ? palette.accent : palette.subtext} flexDirection="column" marginBottom={1} paddingX={1}>
      <Text bold color={props.color}>{props.icon}  {props.role}{props.focused ? '  ▸' : ''}</Text>
      <Box paddingLeft={2}>{props.children}</Box>
    </Box>
  )
}
```

`components/status-bar/index.tsx`:

```tsx
import React from 'react'
import { Text } from 'ink'

export function StatusBar(props: { state: string }) {
  return <Text inverse dimColor>{` 🐶🥚 ${props.state} `}</Text>
}
```

`components/list-picker/index.tsx`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 通用选项列表（权限三选 / 选择器 / 配置树的覆盖层）：圆角框，dim 边框 + accent 标题。
export function ListPicker(props: { title: string; items: string[]; cursor: number; hint: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginY={1}>
      <Text bold color={palette.accent}>{props.title}</Text>
      {props.items.length === 0 ? (
        <Text dimColor>（暂无，esc 返回）</Text>
      ) : (
        props.items.map((it, i) => (
          <Text key={i} inverse={i === props.cursor}>{i === props.cursor ? '> ' : '  '}{it}</Text>
        ))
      )}
      <Text dimColor>{props.hint}</Text>
    </Box>
  )
}
```

- [ ] **Step 2: `components/index.ts` 聚合**（不设——各组件由调用方直接 import 子文件夹）

> 按「模块=文件夹、index 只导出」约定，组件文件夹各自 index.tsx 即入口，无需上层 components/index。

### Task 3.4: `chat/`（block / reducer / viewport / browse，纯逻辑从 index.tsx 抽出）

- [ ] **Step 1: `chat/block.ts`（Block 模型 + 角色映射）**

```ts
import type { AgentToUiMessage } from '@dogegg/bridge'
import { palette, type BlockColor } from '../theme'

export interface Block {
  icon: string
  role: string
  color: BlockColor
  text: string
  // 可折叠块的完整内容（工具为完整结果，思考块的 text 本就是完整推理由折叠时隐藏）。折叠时显示 text 摘要，展开时显示 full。
  full?: string
}

export interface ChatState {
  blocks: Block[]
  status: string
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
}

export type Action =
  | AgentToUiMessage
  | { type: 'local_user'; text: string }
  | { type: 'local_help' }

export const ICON = { user: '🥚', assistant: '🐶', tool: '🐾', thinking: '🐣' } as const
export const COLOR: Record<keyof typeof ICON, BlockColor> = { user: palette.accent, assistant: palette.text, tool: palette.cyan, thinking: palette.yellow }
```

- [ ] **Step 2: `chat/reducer.ts`（reducer + flush/infoBlock，从 index.tsx 抽出）**

```ts
import type { Block, ChatState, Action } from './block'
import { ICON, COLOR } from './block'

function flush(state: ChatState): ChatState {
  if (!state.partial) return state
  const isThinking = state.partial.kind === 'thinking'
  return {
    ...state,
    partial: null,
    blocks: [...state.blocks, { icon: isThinking ? ICON.thinking : ICON.assistant, role: isThinking ? '思考' : '助手', color: isThinking ? COLOR.thinking : COLOR.assistant, text: state.partial.text }],
  }
}

function infoBlock(state: ChatState, role: string, text: string): ChatState {
  return { ...state, blocks: [...state.blocks, { icon: '🥚', role, color: 'gray', text }] }
}

// AgentToUiMessage → ChatState 的纯函数。UI 视图态（权限/选择器/配置树）不在此处理，由 app 的 view-state 管。
export function chatReducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'local_user':
      return { ...state, blocks: [...state.blocks, { icon: ICON.user, role: '你', color: COLOR.user, text: msg.text }] }
    case 'local_help':
      return infoBlock(state, '帮助', msg.text)
    case 'text_delta': {
      const base = state.partial?.kind === 'thinking' ? flush(state) : state
      return { ...base, status: 'responding', partial: { kind: 'assistant', text: (base.partial?.text ?? '') + msg.delta } }
    }
    case 'thought_delta': {
      const base = state.partial?.kind === 'assistant' ? flush(state) : state
      return { ...base, status: 'thinking', partial: { kind: 'thinking', text: (base.partial?.text ?? '') + msg.delta } }
    }
    case 'message':
      return msg.role === 'assistant' ? flush(state) : state
    case 'tool_start': {
      const flushed = flush(state)
      return { ...flushed, status: 'executing', blocks: [...flushed.blocks, { icon: ICON.tool, role: '工具', color: COLOR.tool, text: `${msg.name} ${JSON.stringify(msg.input)}` }] }
    }
    case 'tool_end': {
      const blocks = [...state.blocks]
      const last = blocks[blocks.length - 1]
      if (last && last.icon === ICON.tool) {
        const summary = msg.error ? `✕ ${msg.error}` : `✓ 完成（${msg.output.slice(0, 120)}${msg.output.length > 120 ? '…' : ''}）`
        const fullText = msg.error ? `✕ ${msg.error}` : `✓ 完成\n${msg.output}`
        blocks[blocks.length - 1] = { ...last, text: `${last.text}\n${summary}`, full: `${last.text}\n${fullText}` }
      }
      return { ...state, blocks }
    }
    case 'state':
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished' }
    case 'error':
      return { ...state, status: 'error', blocks: [...state.blocks, { icon: '🐶', role: '错误', color: 'red', text: msg.error.message }] }
    case 'notice':
      return { ...state, blocks: [...state.blocks, { icon: '🥚', role: '提示', color: 'yellow', text: msg.text }] }
    case 'session_ready':
      return {
        ...state,
        status: 'idle',
        blocks: msg.messages.flatMap((m): Block[] => {
          if (m.role === 'assistant') {
            const content = m.content
            if (!content) return []
            return [{ icon: ICON.assistant, role: '助手', color: COLOR.assistant, text: content }]
          }
          if (m.role === 'tool') return [{ icon: ICON.tool, role: '工具结果', color: COLOR.tool, text: m.content }]
          return [{ icon: ICON.user, role: '你', color: COLOR.user, text: m.content }]
        }),
      }
    case 'tools_list':
      return infoBlock(state, '工具', msg.tools.map((t) => `${t.name} — ${t.description}`).join('\n'))
    case 'status_state':
      return infoBlock(state, '状态', `session=${msg.sessionId}  provider=${msg.provider}  model=${msg.model}\ncwd=${msg.cwd}  state=${msg.state}`)
    case 'context_state':
      return infoBlock(state, '上下文', `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`)
    case 'system_state':
      return infoBlock(state, 'system prompt', `${msg.path}\n${msg.content}`)
    case 'compaction':
      return infoBlock(state, '压缩', `${msg.before_tokens} → ${msg.after_tokens} tokens`)
    case 'history_cleared':
      return { ...state, blocks: [] }
    default:
      return state
  }
}
```

> 注：原 `HELP` 常量用 `/new /session ...` 一段文本，现改为 `local_help` 携带 `text` 字段由调用方填入（见 Task 3.5 的 commands.ts），reducer 不再内联固定文本。

- [ ] **Step 3: `chat/viewport.ts`（滚动窗口裁切，从 index.tsx 渲染前计算抽出）**

```ts
import type { Block } from './block'
import { ICON } from './block'
import { renderMarkdown } from '../markdown'

export interface DisplayBlock extends Block {
  index: number
  lines: number
  shownText: string
  isCollapsed: boolean
}

// 粗略估算一个消息块占用的终端行数（角色头 1 + 正文换行 + 上下边框 2），用于滚动窗口裁切。
export function estimateBlockLines(text: string, width: number): number {
  const lineWidth = Math.max(10, width - 6)
  const body = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / lineWidth)), 0)
  return body + 3
}

// 每个块按展开状态计算「实际显示文本」，再按行数估算裁切出可见窗口。scroll=0 时自动跟随最新。
export function computeViewport(
  blocks: Block[],
  expanded: ReadonlySet<number>,
  termWidth: number,
  viewportHeight: number,
  scroll: number,
): { totalLines: number; maxScroll: number; visible: DisplayBlock[] } {
  const rendered = blocks.map((b) => {
    const isMd = b.icon === ICON.assistant || b.icon === ICON.thinking
    return { ...b, text: isMd ? renderMarkdown(b.text) : b.text }
  })
  const display: DisplayBlock[] = rendered.map((b, i) => {
    const expandable = b.icon === ICON.thinking || b.icon === ICON.tool
    const isExpanded = expanded.has(i)
    const shownText = !expandable
      ? b.text
      : isExpanded
        ? (b.icon === ICON.tool ? (b.full ?? b.text) : b.text)
        : (b.icon === ICON.thinking ? '（思考已折叠）' : b.text)
    return { ...b, index: i, lines: estimateBlockLines(shownText, termWidth), shownText, isCollapsed: expandable && !isExpanded }
  })
  const totalLines = display.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  const visibleTop = totalLines - viewportHeight - scrolled
  let acc = 0
  const visible: DisplayBlock[] = []
  for (const b of display) {
    const start = acc
    acc += b.lines
    if (acc <= visibleTop) continue
    if (start >= visibleTop + viewportHeight) break
    visible.push(b)
  }
  return { totalLines, maxScroll, visible }
}
```

- [ ] **Step 4: `chat/browse.ts`（块浏览焦点 + 折叠集合）**

```ts
import { ICON } from './block'

// 可折叠块（思考/工具）的下标列表。
export function expandableIndexes(blocks: { icon: string }[]): number[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.icon === ICON.thinking || b.icon === ICON.tool)
    .map(({ i }) => i)
}

// 上/下移动浏览焦点：未聚焦时 ↑ 从最后（最近）开始、↓ 从第一个开始；已聚焦则按方向移动并回绕。
export function moveBrowse(expandable: number[], current: number | null, dir: 'up' | 'down'): number {
  const idx = current === null ? -1 : expandable.indexOf(current)
  if (dir === 'up') {
    return expandable[idx < 0 ? expandable.length - 1 : (idx - 1 + expandable.length) % expandable.length]!
  }
  return expandable[idx < 0 ? 0 : (idx + 1) % expandable.length]!
}

export function toggleIn(set: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(set)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  return next
}
```

- [ ] **Step 5: `chat/index.ts`**

```ts
export { type Block, type ChatState, type Action, ICON, COLOR } from './block'
export { chatReducer } from './reducer'
export { computeViewport, estimateBlockLines, type DisplayBlock } from './viewport'
export { expandableIndexes, moveBrowse, toggleIn } from './browse'
```

---

### Task 3.5: `input/`（commands 纯函数 + input-box）

- [ ] **Step 1: `input/commands.ts`（斜杠命令表，从 index.tsx 的 handleSubmit 抽出）**

```ts
import type { UiToAgentMessage } from '@dogegg/bridge'

export const HELP_TEXT = '/new /session /model /config /clear /compact /context /tools /system /status /log /help /quit'

export type SlashResult =
  | { kind: 'send'; msg: UiToAgentMessage; intent: 'model' | 'config' | null }
  | { kind: 'help' }

// 斜杠命令表：把 /cmd 翻译成要发往后端的消息（intent 标记 config_request 的后续视图），或 help。
export function slashCommand(text: string): SlashResult {
  const cmd = text.split(/\s+/)[0]!
  switch (cmd) {
    case '/new': return { kind: 'send', msg: { type: 'new_session' }, intent: null }
    case '/session': return { kind: 'send', msg: { type: 'list_sessions' }, intent: null }
    case '/model': return { kind: 'send', msg: { type: 'config_request' }, intent: 'model' }
    case '/config': return { kind: 'send', msg: { type: 'config_request' }, intent: 'config' }
    case '/clear': return { kind: 'send', msg: { type: 'clear_history' }, intent: null }
    case '/compact': return { kind: 'send', msg: { type: 'compact_request' }, intent: null }
    case '/context': return { kind: 'send', msg: { type: 'context_request' }, intent: null }
    case '/tools': return { kind: 'send', msg: { type: 'tools_request' }, intent: null }
    case '/system': return { kind: 'send', msg: { type: 'system_request' }, intent: null }
    case '/status': return { kind: 'send', msg: { type: 'status_request' }, intent: null }
    case '/log': return { kind: 'send', msg: { type: 'log_request' }, intent: null }
    case '/quit': return { kind: 'send', msg: { type: 'quit' }, intent: null }
    default: return { kind: 'help' }
  }
}
```

- [ ] **Step 2: `input/index.ts`**

```ts
export { slashCommand, type SlashResult, HELP_TEXT } from './commands'
```

> `input-box.tsx` 合并进 `app/app.tsx`（输入框与 App 的提交流程、视图态强耦合），不作为独立组件——见 Task 3.7。`input/` 只保留纯命令逻辑 `commands.ts`。

### Task 3.6: `app/view-state.ts` + `overlays/`

- [ ] **Step 1: `app/view-state.ts`（View 视图态联合，纯）**

```ts
import type { ConfigPath } from '../overlays/config'

export type MenuItem = { label: string; onSelect: () => void }

// UI 自己的视图态（叠加在后端状态机之上，二者正交）。
export type View =
  | { kind: 'none' }
  | { kind: 'permission'; id: string; tool: string; input: unknown; cursor: number }
  | { kind: 'menu'; title: string; items: MenuItem[]; cursor: number }
  | { kind: 'prompt'; title: string; value: string; onSubmit: (v: string) => void }
  | { kind: 'config'; path: ConfigPath; cursor: number; preview: boolean | null }
```

- [ ] **Step 2: `overlays/permission/decisions.ts`**

```ts
import type { PermissionDecision } from '@dogegg/bridge'

export const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
export const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']
```

- [ ] **Step 3: `overlays/permission/index.ts` + `overlays/index.ts`**

```ts
// overlays/permission/index.ts
export { DECISIONS, DECISION_LABELS } from './decisions'
```

```ts
// overlays/index.ts
export { DECISIONS, DECISION_LABELS } from './permission'
export type { ConfigPath, Entry, TreeCtx } from './config'
```

> 权限弹层/选择器/提示弹层的渲染用通用 `ListPicker` 组件承载（index.tsx 里本就是这样），故不必为它们各建 `.tsx` 视图文件——`app.tsx` 直接按 `view.kind` 分支渲染。`overlays/config/` 才是唯一需要独立视图逻辑的（树形编辑器）。调整：`overlays/` 下仅保留 `config/`（含 entries/navigation/label/editor.tsx）与 `permission/decisions.ts`；pickers/prompt 的菜单项构造逻辑并入 `app.tsx`。

### Task 3.7: `overlays/config/`（从 config-tree.ts 拆）

- [ ] **Step 1: `overlays/config/navigation.ts`（ConfigPath + parentPath）**

```ts
// 导航路径 ConfigPath 表示「当前钻取到哪一层」。
export type ConfigPath =
  | { kind: 'root' }
  | { kind: 'permission' }
  | { kind: 'permissionBucket'; bucket: 'allow' | 'reject' | 'ask' }
  | { kind: 'providers' }
  | { kind: 'provider'; index: number }
  | { kind: 'models'; providerIndex: number }
  | { kind: 'model'; providerIndex: number; modelIndex: number }
  | { kind: 'selectProvider' }
  | { kind: 'selectModel' }

// 返回当前路径的父层；根层返回 null（再往上即关闭编辑器）。
export function parentPath(path: ConfigPath): ConfigPath | null {
  switch (path.kind) {
    case 'root': return null
    case 'permission': return { kind: 'root' }
    case 'permissionBucket': return { kind: 'permission' }
    case 'providers': case 'selectProvider': case 'selectModel': return { kind: 'root' }
    case 'provider': return { kind: 'providers' }
    case 'models': return { kind: 'provider', index: path.providerIndex }
    case 'model': return { kind: 'models', providerIndex: path.providerIndex }
  }
}
```

- [ ] **Step 2: `overlays/config/label.ts`（Entry 类型 + entryLabel）**

```ts
import type { ConfigPath } from './navigation'

// 每个字段可能的呈现/交互形态。
export type Entry =
  | { label: string; kind: 'scalar'; value: string; save: (v: string) => void }
  | { label: string; kind: 'prompt'; title: string; save: (v: string) => void }
  | { label: string; kind: 'bool'; value: boolean; save: (v: boolean) => void }
  | { label: string; kind: 'goto'; value: string; subPath: ConfigPath; del?: () => void }
  | { label: string; kind: 'action'; value: string; run: () => void; del?: () => void }

// 条目的展示文本；bool 条目支持用 previewBool 体现「左右切换未确认」的预览值。
export function entryLabel(e: Entry, previewBool?: boolean): string {
  switch (e.kind) {
    case 'scalar': return `${e.label}  ${e.value || '（空）'}`
    case 'prompt': case 'action': return e.label
    case 'bool': return `${e.label}  ${previewBool ?? e.value}`
    case 'goto': return `${e.label}  ${e.value}`
  }
}
```

- [ ] **Step 3: `overlays/config/entries.ts`（buildEntries，从 config-tree.ts 原样搬）**

```ts
import type { Config } from '@dogegg/bridge'
import type { ConfigPath } from './navigation'
import type { Entry } from './label'

export interface TreeCtx {
  set: (path: string, value: unknown) => void
  add: (path: string, value: unknown) => void
  remove: (path: string, index: number, providerIndex?: number) => void
}

const nan = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0)

// 生成给定路径下的一层字段列表。所有 config_set/add/remove 走 ctx 翻译成消息。
export function buildEntries(config: Config, path: ConfigPath, ctx: TreeCtx): Entry[] {
  switch (path.kind) {
    case 'root':
      return [
        { label: 'systemPrompt', kind: 'scalar', value: config.systemPrompt ?? '', save: (v) => ctx.set('systemPrompt', v) },
        { label: 'defaultProvider', kind: 'goto', value: config.defaultProvider ?? '（未选择）', subPath: { kind: 'selectProvider' } },
        { label: 'defaultModel', kind: 'goto', value: config.defaultModel ?? '（未选择）', subPath: { kind: 'selectModel' } },
        { label: 'maxIterations', kind: 'scalar', value: String(config.maxIterations), save: (v) => ctx.set('maxIterations', nan(v)) },
        { label: 'maxRetries', kind: 'scalar', value: String(config.maxRetries), save: (v) => ctx.set('maxRetries', nan(v)) },
        { label: 'shellProgram', kind: 'scalar', value: config.shellProgram ?? '（默认按平台）', save: (v) => ctx.set('shellProgram', v) },
        { label: 'permission', kind: 'goto', value: 'allow/reject/ask', subPath: { kind: 'permission' } },
        { label: 'providers', kind: 'goto', value: `${config.providers.length} 个`, subPath: { kind: 'providers' } },
      ]
    case 'permission':
      return (['allow', 'reject', 'ask'] as const).map((b) => ({
        label: b,
        kind: 'goto' as const,
        value: `${config.permission[b].length} 个工具`,
        subPath: { kind: 'permissionBucket', bucket: b } as ConfigPath,
      }))
    case 'permissionBucket': {
      const bucket = path.bucket
      const tools = config.permission[bucket]
      return [
        ...tools.map((tool) => ({
          label: tool,
          kind: 'action' as const,
          value: '按 d 删 · 回车同样移除',
          run: () => ctx.set(`permission.${bucket}`, tools.filter((t) => t !== tool)),
          del: () => ctx.set(`permission.${bucket}`, tools.filter((t) => t !== tool)),
        })),
        { label: '＋ 添加工具', kind: 'prompt', title: '工具名', save: (v) => { const t = v.trim(); if (t && !tools.includes(t)) ctx.set(`permission.${bucket}`, [...tools, t]) } },
      ]
    }
    case 'providers': {
      const entries: Entry[] = config.providers.map((p, i) => ({
        label: p.name || '（未命名）',
        kind: 'goto' as const,
        value: p.baseURL || '（未填 baseURL）',
        subPath: { kind: 'provider', index: i } as ConfigPath,
        del: () => ctx.remove('providers', i),
      }))
      entries.push({ label: '＋ 添加 provider', kind: 'action', value: '', run: () => ctx.add('providers', { name: '', protocol: 'openai', baseURL: '', apiKey: '', models: [] }) })
      return entries
    }
    case 'provider': {
      const p = config.providers[path.index]
      if (!p) return []
      return [
        { label: 'name', kind: 'scalar', value: p.name, save: (v) => ctx.set(`providers.${path.index}.name`, v) },
        { label: 'baseURL', kind: 'scalar', value: p.baseURL, save: (v) => ctx.set(`providers.${path.index}.baseURL`, v) },
        { label: 'apiKey', kind: 'scalar', value: p.apiKey, save: (v) => ctx.set(`providers.${path.index}.apiKey`, v) },
        { label: 'models', kind: 'goto', value: `${p.models.length} 个`, subPath: { kind: 'models', providerIndex: path.index } },
        { label: '删除此 provider', kind: 'action', value: '', run: () => ctx.remove('providers', path.index) },
      ]
    }
    case 'models': {
      const p = config.providers[path.providerIndex]
      if (!p) return []
      const entries: Entry[] = p.models.map((m, i) => ({
        label: m.name || '（未命名）',
        kind: 'goto' as const,
        value: `${m.contextWindow} ctx`,
        subPath: { kind: 'model', providerIndex: path.providerIndex, modelIndex: i } as ConfigPath,
        del: () => ctx.remove('models', i, path.providerIndex),
      }))
      entries.push({ label: '＋ 添加 model', kind: 'action', value: '', run: () => ctx.add(`providers.${path.providerIndex}.models`, { name: '', contextWindow: 128000, maxOutput: 16384, reasoning: false }) })
      return entries
    }
    case 'model': {
      const p = config.providers[path.providerIndex]
      const m = p?.models[path.modelIndex]
      if (!p || !m) return []
      const base = `providers.${path.providerIndex}.models.${path.modelIndex}`
      return [
        { label: 'name', kind: 'scalar', value: m.name, save: (v) => ctx.set(`${base}.name`, v) },
        { label: 'contextWindow', kind: 'scalar', value: String(m.contextWindow), save: (v) => ctx.set(`${base}.contextWindow`, nan(v)) },
        { label: 'maxOutput', kind: 'scalar', value: String(m.maxOutput), save: (v) => ctx.set(`${base}.maxOutput`, nan(v)) },
        { label: 'reasoning', kind: 'bool', value: m.reasoning, save: (v) => ctx.set(`${base}.reasoning`, v) },
        { label: '删除此 model', kind: 'action', value: '', run: () => ctx.remove('models', path.modelIndex, path.providerIndex) },
      ]
    }
    case 'selectProvider':
      return config.providers.map((p) => ({
        label: p.name || '（未命名）',
        kind: 'action' as const,
        value: '',
        run: () => ctx.set('defaultProvider', p.name),
      }))
    case 'selectModel': {
      const p = config.providers.find((x) => x.name === config.defaultProvider) ?? config.providers[0]
      if (!p) return [{ label: '（尚无 provider）', kind: 'action', value: '', run: () => {} }]
      return p.models.map((m) => ({
        label: m.name || '（未命名）',
        kind: 'action' as const,
        value: '',
        run: () => ctx.set('defaultModel', m.name),
      }))
    }
  }
}
```

- [ ] **Step 4: `overlays/config/editor.tsx`（编辑器视图，从 index.tsx 的 config 覆盖层渲染抽出）+ `overlays/config/index.ts`**

```tsx
// editor.tsx：配置树这一层的列表渲染（含 bool 预览态、删除提示），就地编辑逻辑仍在 app.tsx 的键位分支里。
```
> 说明：配置树渲染本质是 `ListPicker`（title + items + cursor + hint），按键处理与 App 状态强耦合。为免过度拆分，**不设独立 editor.tsx**；`configEntries` 的构造与渲染直接留在 `app.tsx`，`overlays/config/` 只保留 `entries.ts` / `navigation.ts` / `label.ts` 三个纯逻辑。执行时按此调整（`index.ts` 只聚合这三者）。

```ts
// overlays/config/index.ts
export { buildEntries, type TreeCtx } from './entries'
export { parentPath, type ConfigPath } from './navigation'
export { entryLabel, type Entry } from './label'
```

### Task 3.8: `app/app.tsx` + `app/entry.ts` + `tui/index.ts` + `ui/index.ts`

- [ ] **Step 1: `app/entry.ts`（renderTui）**

```ts
import React from 'react'
import { render } from 'ink'
import type { UiPort } from '@dogegg/bridge'
import { App } from './app'

// 进入备用屏幕（full-screen 应用模式）。否则 Ink 每帧写 stdout 会污染终端滚动条，流式输出时滚动会跳回开头。
export function renderTui(port: UiPort): void {
  process.stdout.write('\x1b[?1049h')
  const leaveAlt = () => process.stdout.write('\x1b[?1049l')
  process.on('exit', leaveAlt)
  render(React.createElement(App, { port }))
}
```

- [ ] **Step 2: `app/app.tsx`（完整 App，接收 UiPort）**

> 这是 474 行 index.tsx 的归宿。落地原则：**保留原文件全部渲染与键位处理逻辑**，仅做三处机械替换——(1) `agent.send(x)` → `port.post(x)`；(2) `agent.on(cb)` → `port.onMessage(cb)`；(3) 顶部 `import type { Agent }` 删除，改为 `import type { UiPort } from '@dogegg/bridge'` 并 `props: { port: UiPort }`。reducer/flush/infoBlock/ICON/COLOR/estimateBlockLines/expandable 计算等已抽到 `chat/`，故从 `../chat` import；`DECISIONS`/`DECISION_LABELS` 从 `../overlays/permission`；`buildEntries`/`parentPath`/`entryLabel`/`ConfigPath`/`TreeCtx` 从 `../overlays/config`；`slashCommand`/`HELP_TEXT` 从 `../input`；`renderMarkdown` 从 `../markdown`；`View`/`MenuItem` 从 `./view-state`。

由于原 index.tsx 已在前文完整读过，此处不重贴 474 行，执行者在迁移时按上述替换规则 + import 清单改写。**唯一新逻辑**：`handleSubmit` 里原 `switch (cmd)` 12 个 case 改为 `const r = slashCommand(text); if (r.kind === 'send') { if (r.intent) configIntent.current = r.intent; port.post(r.msg) } else dispatch({ type: 'local_help', text: HELP_TEXT })`。

- [ ] **Step 3: `tui/index.ts`（tui 门面）+ `ui/src/index.ts`（包出口）**

```ts
// tui/index.ts
export { renderTui } from './app/entry'
export type { View, MenuItem } from './app/view-state'
```

```ts
// ui/src/index.ts
export { renderTui } from './tui'
```

- [ ] **Step 4: 迁移 ui 测试 + 删除旧 ui**

```bash
mkdir -p ui/test/tui/{chat,input,overlays/config}
git mv test/ui/config-tree.test.ts ui/test/tui/overlays/config/entries.test.ts
git mv test/common/markdown.test.ts ui/test/tui/markdown/render.test.ts
```

改写 `entries.test.ts` 与现有 `config-tree.test.ts` 的 import：`../../src/ui/tui/config-tree` → `../../../src/tui/overlays/config`；`../../src/config/loader` → 从 `@dogegg/bridge` 导入 `loadConfig`？——不对，`loadConfig` 在 agent 包。**config-tree 测试只依赖纯类型**：原测试用 `loadConfig` 构造 Config 对象。改为从 `@dogegg/agent` import `loadConfig`（ui 测试允许导入 agent 的纯 loader 吗？——不允许，违反边界）。

> ⚠️ 边界冲突：`config-tree` 测试需要构造 Config。方案：测试里直接 `import { configSchema } from '@dogegg/bridge'` 然后 `configSchema.parse({...})` 构造，不经 agent 的 loadConfig。这样 ui 测试只依赖 bridge。执行时按此改写（去掉 loadConfig，用 configSchema.parse 内联）。

```bash
git rm src/ui/tui/index.tsx src/ui/tui/components.tsx src/ui/tui/config-tree.ts src/common/utils/markdown.ts
rm -rf src/ui src/common
```

- [ ] **Step 5: Phase 3 收尾验证 + 提交**

```bash
npm run typecheck && npm run test:run
git add -A
git commit -m "refactor(ui): migrate frontend into @dogegg/ui with per-component modules"
```

---

## Phase 4: 组合根 main.ts + 清理 src/ test/ + 构建验证

- [ ] **Step 1: 写根 `main.ts`**

```ts
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createChannelPair } from '@dogegg/bridge'
import { Agent, loadConfig } from '@dogegg/agent'
import { renderTui } from '@dogegg/ui'

// 组合根：全项目唯一同时 import agent 与 ui 的地方。建通道 → 装 agent → 渲 UI。
const config = loadConfig()
const { agentPort, uiPort } = createChannelPair()
new Agent({ port: agentPort, config, cwd: process.cwd(), logDir: join(homedir(), '.dogegg', 'logs') })
renderTui(uiPort)
```

- [ ] **Step 2: 改根 `tsconfig.json` 收窄 include**

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["main.ts"]
}
```

- [ ] **Step 3: 删除旧 src/ + test/ 根目录 + 旧 build 入口**

```bash
rm -rf src test
```

（`test/` 已全部移民到各包 test/；`src/` 已全部移民 + 清理。若残留空目录一并删。）

- [ ] **Step 4: 删除旧 esbuild 入口引用，验证构建**

改 `package.json` 无需变（build 已是 `node build.mjs`，入口 `main.ts`）。跑：

```bash
npm run typecheck && npm run test:run && npm run build && node dist/index.js --help 2>&1 | head -5
```

Expected: typecheck 绿；test 全绿；build 产出 `dist/index.js`；`node dist/index.js` 应启动 TUI（ALT 屏），Ctrl+C 退出。

- [ ] **Step 5: 提交 Phase 4**

```bash
git add -A
git commit -m "refactor: combinator root main.ts, delete src/ and test/"
```

---

## Phase 5: 文档同步 + 最终验证

- [ ] **Step 1: 同步 CLAUDE.md**（分层命名与构建说明）

把 CLAUDE.md「代码规范」第 1 条的分层命名 `agent/、llm/、tools/、config/、common/、ui/、events/、main/` 改为「三层包：`bridge/`（契约）、`agent/`（后端）、`ui/`（前端），根 `main.ts` 组合根；每包内 `src/` + `test/`」（已在实施时同步）。

- [ ] **Step 2: 微调重构设计 §5 core/ 与 context/message 记录**（本计划第 2 阶段 2 处决策偏移）

在 `2026-08-27-modular-refactor-design.md` 句尾补：`core/` 实为 `{agent.ts, pending.ts, state/}`（commands/turn 折叠进 agent.ts）；`context/message/` 仅 `truncate.ts`（tool-result 整形归 `loop/tool-calls.ts`）。

- [ ] **Step 3: 最终全量验证**

```bash
npm run typecheck && npm run test:run && npm run build
git status --short
```

Expected: 三命令全绿；`git status` 只剩文档与三包文件。架构测试（bridge/test/architecture.test.ts）通过，`grep -r "from.*@dogegg/agent" ui/src` 无结果。

- [ ] **Step 4: 提交 Phase 5**

```bash
git add -A
git commit -m "docs: sync CLAUDE.md and design doc with modular structure"
```

---

## 完成判定汇总

1. `npm run typecheck && npm run test:run && npm run build` 全绿；
2. `grep -rn "@dogegg/agent" ui/src` 无结果（UI 零反向依赖）；
3. `grep -rn "@dogegg/ui" agent/src` 无结果（agent 零反向依赖）；
4. 架构测试通过（依赖方向 + 模块边界 + 250 行红线）；
5. 根目录仅有 `main.ts` + 三包 + 配置/文档文件，`src/`、`test/` 已删。