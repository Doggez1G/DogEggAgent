# DogEggAgent 设计文档

> 状态：已确认，待进入实现计划
> 日期：2026-08-26

## 1. 项目定位

DogEggAgent 是一个自研的 **code agent** 工具。第一目标是**学习并理解 agent 的实现**，而非追求工程完备度。因此所有设计决策优先服务于「把 agent 的核心机制拆清楚、能看懂、能独立测试」。

| 项 | 值 |
|---|---|
| 项目名 | DogEggAgent |
| 形态 | 代码编辑型 Agent |
| 语言/运行时 | TypeScript / Node.js **≥ 20**（依赖内置全局 `fetch`，不依赖 Bun） |
| 交互 | TUI（Ink）；`webui` 仅占位，v1 不实现 |

## 2. 第一原则：后端与前端解耦

**后端**（agent 核心及其依赖的 llm / tools / session / permission 等）与**前端**（ui：tui / webui）**完全解耦**，所有重要的后端行为都通过 **Event** 表达。

`agent/` 与 `ui/` 这两个目录只是「后端」与「前端」两大部分的代称——边界不在字面的这两个文件夹，而在「后端逻辑」与「前端展示」之间。v0.1.0 起二者建模为两个独立的 workspace 包（`agent/`、`ui/`），解耦契约归入第三个包 `bridge/`。

实现方式：
- `bridge/` 是唯一的解耦契约：按方向拆成两套消息类型 `AgentToUiMessage` / `UiToAgentMessage`（见 §6），并提供传输无关的 `Port` 接口（`AgentPort` / `UiPort`）与同进程通道实现 `createChannelPair()`。
- 后端不 import 前端，前端不 import 后端；二者都只依赖 `bridge/`。
- 两者仅在根组合根 `main.ts`（唯一同时 import agent 与 ui 的地方）中通过 Port 对接。
- 两类消息都是**传输无关**的单一事实源：v1 同进程内用 Port 同步投递；将来 WebUI 加 SSE 传输层（在 `bridge/` 内新增通道实现），复用同一套消息类型，不必推倒重来。

消息分两层，职责不同，不可混淆：

1. **LLM 级 StreamEvent**（`agent/src/llm/types.ts`）：provider → agent loop 的流，表达「模型吐了什么」。这是后端内部更底层的一层，不进 `bridge/`。
2. **Agent 级消息**（`bridge/src/contract/`）：后端 ↔ 前端，按方向分成 `out`（后端→前端）与 `in`（前端→后端）两套 union。

## 3. 需求清单

| # | 需求 | 关键决定 |
|---|---|---|
| 1 | Agent Loop | 从零手写；工具**串行**执行；`while`: 问模型 → 有 tool_calls 则串行执行 → 结果回填 → 再问 → 无 tool_calls 结束。**打断/错误保存**：用户 Ctrl+C 打断或 maxIterations/API 失败时，已完成的 assistant/tool 消息保存到 context+history；未配对的 tool_calls 补全 `tool: cancelled` 消息，保证对话状态完整；部分流式文本（半句话）不保存 |
| 2 | Tool Calling | 模型返回 tool_calls，Core 按 schema 本地执行，串行 |
| 3 | Context | 每次发给模型 = System Prompt + 处理后的历史 + 工具 schema，受窗口预算约束 |
| 4 | Message History | 有序消息列表，**原样持久化、永不压缩**；与 Context 是两份独立数据（见 §3.1） |
| 5 | System Prompt | 配置只存**文件路径**，缺省用内置默认文件，用户改文件即可自定义 |
| 6 | Tool Result | 超长结果截断，cap ≈ 8000 字符（截断处注明） |
| 7 | Context Window | 来自**模型配置** `contextWindow`，缺省保守 128k |
| 8 | Agent State | 10 态状态机（见 §4） |
| 9 | Event System | 见 §2 |
| 10 | Permission | 配置 `allow/reject/ask` 三桶 + 运行时 `allow_once/allow_always/reject`（见 §5） |
| 11 | Session | Session ID / 消息持久化 / Resume / History；JSON：`~/.dogegg/sessions/<id>.json`，文件结构 `{ id, updatedAt, history, context, allowedTools }`；REPL 斜杠命令 `/new`、`/session`（列会话并选择切换，按 `updatedAt` 降序排列——最新在最前）管理；**权限会话隔离**：`allow_always` 只对当前会话生效，新建会话（`/new`）时清空，`/session` 切换时保留（授权持久化到 allowedTools 字段，resume 后恢复） |
| 12 | Context Compaction | LLM 把旧上下文压成 summary；触发 80% 窗口、保留最近 4 条；**只压缩 Context，不动 History**（见 §3.1）；自动触发用 80% 阈值，手动 `/compact` 无条件压缩（只要 context 非空就压：消息多时压旧留近期 4 条，消息少时全部压成摘要） |
| 13 | UI | Message List / Markdown / Tool Call / Tool Result / Input / Status Bar / Streaming |

- **Reasoning**：v1 **框架就绪**——思考内容走独立 `thought_delta` 事件，按 OpenAI 官方标准字段解析。⚠️ 仅就绪：o1/o3 等推理模型的真实流式差异（如 `reasoning_effort`、增量 reasoning 协议）v1 不验证，实际可用性以运行时为准。具体字段名（`reasoning_content` 等）在实现时对照 OpenAI 当前文档确认，不在此写死。

### 3.1 History 与 Context 分离（双独立持久化）

历史消息（History）与上下文（Context）是**两份独立的数据**，各自持久化、互不覆盖：

| | History（消息历史） | Context（上下文） |
|---|---|---|
| 用途 | UI 显示历史消息 | 发给模型 |
| 内容 | 完整原文，单调增长，**永不压缩** | 发给模型的消息列表，受窗口预算约束、会压缩 |
| compact 时 | 不动 | 压缩成 `[摘要, 最近 keep 条]` |
| 持久化 | 存原文 | 存压缩结果 |
| resume 时 | 加载原文 → UI 显示 | 加载压缩版 → 喂模型 |

**派生规则**：
- 新消息（user/assistant/tool）产生时**同时 append 到 History 与 Context**。
- compact 只改 Context，History 原封不动——压缩**不可逆地改写 Context 持久化**，但原文始终在 History。
- resume 加载两者：History 给 UI 显示完整历史，Context 给模型用压缩版。**不重新摘要**——Context 压缩后直接存压缩结果，下次 resume 直接加载已存的压缩版。
- compact 触发判断与 token 估算基于 Context（发给模型的就是 Context）。

这样 §3 #4「原样持久化」指 History、#12「压缩」指 Context，两者各管一样，自洽。

**Session 文件结构**：`{ id, updatedAt, history: Message[], context: Message[], allowedTools: string[] }`。

### 3.2 运行中命令分类

`UiToAgentMessage` 在 agent 处于运行态（一轮 loop 进行中）时按影响面分四类处理：

| 类别 | 命令 | 运行中行为 |
|---|---|---|
| **动 loop 工作集**（阻塞） | `submit`、`new_session`、`resume_session`、`clear_history`、`compact_request`、`config_set/add/remove` | emit `notice`（如「运行中，请稍候」），**不静默丢弃** |
| **loop 控制**（仅运行时有意义） | `cancel`、`permission_decision` | 正常处理；非运行态时 cancel 无害 no-op、permission_decision 找不到挂起项则忽略 |
| **纯查询**（任意时刻放行） | `list_sessions`、`config_request`、`tools_request`、`context_request`、`status_request`、`system_request`、`log_request` | 始终处理——只读快照，运行中也能 `/context` 看实时 token |
| **UI 本地**（不发消息） | `/help`、各 overlay 的导航/开关 | 纯前端，与运行态无关 |

config 编辑归「阻塞」：运行中改 config 会让 loop 持有的 provider/permission 引用半生效，turn 结束后生效更干净。

**运行时行为（增补）**：

- **cwd**：以启动 agent 时所在目录为工作目录；无 CLI 参数、无配置项。
- **运行时切换 provider/model**：通过 `/model`（快速）或 `/config`（完整编辑）。
- **LLM 错误重试**：请求失败自动重试 `maxRetries` 次（缺省 3），仍失败则报错给 UI。
- **调试日志**：每轮消息流 / 工具调用 / 状态迁移追加写到 `~/.dogegg/logs/<session-id>.log`。
- **无配置可启动**：找不到配置文件时仍进入 TUI（空配置）；仅 `submit` / `status` / `context` / `compact` 在未配置时发 `notice` 提示先 `/config`。
- **CLI 参数**：v1 无（一切通过 REPL 斜杠命令）。

## 4. 状态机（10 态）

状态语义：

| 态 | 语义 |
|---|---|
| `idle` | 空闲，等待输入 |
| `thinking` | **仅推理模型**：吐 reasoning token 阶段；普通模型没有此态 |
| `responding` | **所有模型**：流式吐最终答案文本 |
| `tool_calling` | 模型返回了 tool_calls，准备逐条执行 |
| `waiting_permission` | 某个工具等待审批 |
| `executing` | 工具执行中 |
| `finished` | 本轮正常结束 |
| `cancelled` | 用户取消（cancel） |
| `error` | 出错 |
| `compacting` | 压缩上下文中（手动 `/compact` 或自动触发 80% 阈值时进入，UI 可感知） |

**通用规则**：每次「重新请求模型」进入 `thinking`（推理模型）或 `responding`（普通模型）。这条规则同时作用于 submit、reject 之后、executing 结果回填之后。

迁移图：

```
idle ──submit──▶ thinking | responding
thinking ──推理结束──▶ responding
responding ──最终答案，无 tool_calls──▶ finished
responding ──返回 tool_calls──▶ tool_calling
tool_calling ──自动放行/已允许──▶ executing
tool_calling ──需审批──▶ waiting_permission
waiting_permission ──allow_once / allow_always──▶ executing
waiting_permission ──reject（回填明确拒绝提示，告知模型勿重试）──▶ thinking | responding
executing ──结果回填，重新请求──▶ thinking | responding
任意运行态 ──compact_start──▶ compacting
compacting ──compact_done──▶ thinking | responding | idle
任意运行态 ──cancel──▶ cancelled
任意运行态 ──error──▶ error
finished / cancelled / error ──▶ idle
```

> **串行执行细化**：一次响应可能携带多个 tool_calls。逐个工具执行期间，单个工具结束后 `executing / waiting_permission ──tool_done──▶ tool_calling`（回到工具阶段，继续下一个）；仅**最后一个**工具结束才 `result_back / reject ──▶ thinking | responding`（重新请求模型，符合 §3 需求 #1 的「串行执行 → 结果回填 → 再问」）。

## 5. 权限模型（两层）

**配置层（静态分类）**：

| 配置桶 | 含义 |
|---|---|
| `allow` | 自动放行，不询问 |
| `reject` | 永远拒绝 |
| `ask` | 每次询问 |

**运行时层（仅 `ask` 桶命中时）**：用户决策三值：

- `allow_once`：仅放行本次调用
- `allow_always`：将工具在本会话内挪入允许。**会话隔离**：`allow_always` 只对当前会话生效，新建会话（`/new`）时清空；切换会话（`/session`）时**保留授权**——授权持久化到 session 文件，resume 后恢复。`/permissions` 可查看/撤销当前会话的授权。
- `reject`：拒绝本次调用（回填明确提示「用户拒绝了此工具调用，请勿再次尝试同一工具」，让模型停止重试而非循环弹框，继续）

审批通过注入的回调交给 UI（TUI = await Y/n），`agent/permission` 本身不依赖 UI。

## 6. 消息契约

**LLM 级 StreamEvent**（`agent/src/llm/types.ts`，provider → agent loop）：

```
text_delta / thought_delta / tool_call_start / tool_call_delta / tool_call_end / done / error
```

其中 `thought_delta` 承载 reasoning 内容，`text_delta` 承载答案文本，UI 可据此把「思考」与「回答」分开展示。这是后端内部更底层的一层。

**Agent 级消息**（`bridge/src/contract/`，后端 ↔ 前端）：按方向拆成两套 union，便于维护；两套都是「消息」，不是「事件 vs 命令」。将来接 SSE 时，序列化/反序列化的正是这两套类型。

```ts
// out: 后端 → 前端
type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'tool'; id: string }   // id 为真值，与 tool_start 的 id 对齐，供 UI 定位/折叠/滚动
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
  | { type: 'permissions_list'; tools: string[] } // /permissions 响应：当前会话的 allow_always 授权列表
  | { type: 'compaction'; before_tokens: number; after_tokens: number; source: 'manual' | 'auto' }
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: { message: string; name?: string } }   // 可序列化形状：进程内 Port 与将来 SSE 同构

// in: 前端 → 后端
type UiToAgentMessage =
  | { type: 'submit'; text: string }
  | { type: 'permission_decision'; id: string; decision: 'allow_once' | 'allow_always' | 'reject' }
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
  | { type: 'permissions_request' } // /permissions：查询当前会话的 allow_always 授权
  | { type: 'permission_revoke'; tool: string } // 撤销某工具的 allow_always 授权
  | { type: 'clear_history' }
  | { type: 'compact_request' }
  | { type: 'quit' }
```

要点：
- `permission_request`（out）与 `permission_decision`（in）通过 `id` 配对。
- `message` 的 `id` 为真值（非空串），与 `tool_start`/`tool_end` 的 `id` 同源，供 UI 做块定位/折叠/滚动跟随。
- **拒绝/失败工具可见**：config `reject` 桶命中、`ask`→用户 reject、未知工具、参数校验失败这四种情况，也发一条 `tool_end`（`error` 标明原因，如 `denied` / `未知工具` / `参数校验失败`），让 UI 能渲染「🐾 tool ✕ denied」。`tool_start` 仅在实际执行前发。
- `error` 用可序列化形状 `{ message, name? }`，agent 侧 emit 时从 `Error` 转换，保证进程内 Port 与将来 SSE 同构。
- `compaction` 带 `source: 'manual' | 'auto'`：手动 `/compact` 弹 info overlay 显示压缩结果（需 esc 关闭）；自动压缩不弹 overlay，只在对话流插一条 dim 提示块（不打断对话流）。
- `/config` 用 `config_set` / `config_add` / `config_remove` 三个通用 path 操作，覆盖对 provider、model 及任意字段的增删改；`config_state` / `config_updated` 携带完整 `Config`。
- `resume_session.id`、`config_*` 的取值均来自 UI 侧选择器，不是用户手打。

**斜杠命令（REPL）**：

| 命令 | 作用 | 触发的消息 |
|---|---|---|
| `/new` | 新建会话 | `new_session` → `session_ready` |
| `/session` | 列出并选择切换会话 | `list_sessions` → `session_list` → `resume_session { id }` → `session_ready` |
| `/config` | 查看/编辑任意配置（provider、model、其它字段） | `config_request` → `config_state` → `config_set/add/remove` → `config_updated` |
| `/model` | 快速切换 provider/model | 复用 `config_request` → `config_state` → `config_set { path: 'defaultProvider' | 'defaultModel' }` |
| `/clear` | 清空当前会话历史 | `clear_history` → `history_cleared` |
| `/compact` | 手动压缩上下文 | `compact_request` → `compaction` |
| `/context` | 查看上下文占用 | `context_request` → `context_state` |
| `/tools` | 列出工具 | `tools_request` → `tools_list` |
| `/system` | 查看 system prompt | `system_request` → `system_state` |
| `/status` | 会话/模型/上下文一览 | `status_request` → `status_state` |
| `/log` | 查看调试日志 | `log_request` → `log_state` |
| `/permissions` | 查看/撤销当前会话的 allow_always 授权 | `permissions_request` → `permissions_list` → `permission_revoke { tool }` → `permissions_list` |
| `/help` | 列出所有命令 | UI 本地渲染（无后端消息） |
| `/quit` | 退出 | `quit` |

## 7. 配置 schema

```json
{
  "systemPrompt": "~/.dogegg/prompts/system.md",
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o",
  "maxIterations": 50,
  "maxRetries": 3,
  "shellProgram": "cmd",
  "permission": {
    "allow": ["read_file"],
    "reject": [],
    "ask": ["write_file", "edit_file", "shell"]
  },
  "providers": [
    {
      "name": "openai",
      "protocol": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "...",
      "models": [
        { "name": "gpt-4o", "contextWindow": 128000, "maxOutput": 16384, "reasoning": false },
        { "name": "gpt-4o-mini", "contextWindow": 128000, "maxOutput": 16384, "reasoning": false }
      ]
    }
  ]
}
```

关键点：
- 顶层 `defaultProvider` + `defaultModel` 组合定位到某个模型；`defaultModel` 引用某 provider 下某个 model 的 `name`。
- 一个 provider 下可有多个 model；每个 model 是对象：`name` / `contextWindow` / `maxOutput` / `reasoning`。
- `reasoning` 布尔标记该模型是否为推理模型（缺省 `false`），驱动 `thinking` 态与 `thought_delta` 事件。
- 同一协议可配置多个 provider 实例（例如多个 OpenAI 兼容端点），每个实例独立 `name/baseURL/apiKey/models`。v1 只实现 `protocol: "openai"`，架构预留多协议。
- `systemPrompt` 只存文件路径，支持绝对路径、`~` 展开、相对配置文件所在目录。
- `maxRetries`：LLM 请求失败重试次数（缺省 3），仍失败则报错。
- `shellProgram`：shell 工具的解释器（缺省按平台——Windows `cmd` / 其它 `bash`，可 `powershell` / `bash` / `sh` 等），详见 §8。
- `providers` 允许为空、provider/model 的 `name/baseURL/apiKey/models` 在编辑阶段允许暂时为空，以支持 `/config` 树形「自由填字段」；能否对话由 `isConfigured()` 做完整性判定。
- provider/model 的 `name` **必须唯一**（仅非空名判重，编辑期空名暂允许多个）；数组项的增删改均按 index 定位。
- 找不到配置文件时 `loadConfig()` 返回空配置（而非抛错），可启动但提问被 `notice` 引导去 `/config`。
- 配置文件位置：项目内 `.dogegg.json` 优先，否则 `~/.dogegg/config.json`。

## 8. 工具清单（4 个，snake_case）

| 工具 | 说明 |
|---|---|
| `read_file` | 读取文件内容 |
| `write_file` | 整文件覆写/创建 |
| `edit_file` | old_string → new_string 精准替换（code agent 核心） |
| `shell` | 执行 shell 命令（解释器可配），捕获 stdout/stderr/exit code，返回可 kill 进程句柄 |

工具契约：

```ts
interface Tool {
  name: string
  description: string
  schema: ZodSchema            // 校验 LLM 返回的参数
  parameters: JsonSchema       // 暴露给 LLM 的 OpenAI function schema
  execute(args, ctx): Promise<ToolResult>   // ctx: cwd / signal
}
```

`tools/registry.ts` 汇总所有工具的 `name/schema/execute`。工具参数（LLM 返回的 JSON）用 **zod** 校验。

**`shell` 与取消（cancel）**：
- `shell` 的解释器来自配置 `shellProgram`（缺省按平台——Windows 默认 `cmd`，可切 `powershell`/`bash`），通过 `spawn(program, [flag, command])` 显式指定（`cmd → /c`、`powershell → -Command`、`bash/sh → -c`）。不用 `shell: true`（会触发 Node DEP0190 弃用警告）；`shellProgram` 含非 ASCII（如误存的占位文本）时自动回退到平台默认。
- `shell` 的进程可被取消杀死：工具把 `killTree` 挂在 `ctx.signal` 的 `abort` 监听上，取消时由外层 `AbortController` 触发杀进程树。
- 取消三件套：`AbortController` 中断 LLM 请求 + 工具之间检查取消标志 + 杀 shell 进程树。
- `killTree` 按 OS 分支：`win32` 用 `taskkill /PID <pid> /T /F`（杀整棵树，对 cmd/powershell/bash 通用）；POSIX 用 detached 进程组 + `process.kill(-pid, 'SIGKILL')`。杀进程**不按 shell 类型**区分，只按 OS。

## 9. 目录结构

v0.1.0 起采用 npm workspaces 真多包 + 每个包内部再细分子模块的四层结构。完整文件级结构以 `2026-08-27-modular-refactor-design.md` 为准，这里给出权威概览：

```
DogEggAgent/
├─ main.ts                 # 组合根（唯一同时 import agent 与 ui 的地方，~25 行）
├─ package.json            # workspaces: ["agent","ui","bridge"]
├─ tsconfig.base.json      # 共享 compilerOptions（strict / bundler 解析）
├─ build.mjs               # esbuild 构建脚本（含 @dogegg/* 解析插件）
├─ agent/                  # @dogegg/agent：后端域
│  ├─ package.json / tsconfig.json
│  ├─ src/                 # core / loop / context / llm / tools / session / permission / config / shared
│  └─ test/
├─ ui/                     # @dogegg/ui：前端域（仅此包开 jsx）
│  ├─ package.json / tsconfig.json
│  ├─ src/tui/             # app / chat / input / overlays / components / theme / markdown
│  └─ test/
└─ bridge/                 # @dogegg/bridge：契约 + 通道
   ├─ package.json / tsconfig.json
   ├─ src/                 # contract（消息 + 跨界数据类型 + Config schema）/ channel（Port + 同进程实现）
   └─ test/
```

**依赖约束（唯一硬约束）**：

- 后端与前端互不 import，都只依赖 `bridge/`；`bridge/` 不依赖任何兄弟包。二者仅在根 `main.ts` 对接。
- 除此之外，各子域之间谁依赖谁，由 `bridge/test/architecture.test.ts` 依据子域依赖矩阵强制（见重构设计 §9）。
- 模块 = 文件夹，`index.ts` 是唯一对外脸面；文件夹内按职责分文件（禁止单文件大杂烩）；`src/` 源文件 ≤ 250 行。

## 10. 技术选型

| 项 | 选择 |
|---|---|
| LLM 传输 | 原生 `fetch`（Node≥20）+ 手写 SSE 解析（读 `response.body` 流） |
| 校验 | **zod**（配置 + 工具参数 + 消息结构，全部） |
| 持久化 | JSON 文件 |
| TUI | Ink（`ink` + `ink-text-input`） |
| Markdown 渲染 | `marked`（Lexer 解析后渲染为干净纯文本；刻意不用 marked-terminal 的 ANSI，避免与 Ink 颜色处理冲突） |
| 日志 | 追加写文本到 `~/.dogegg/logs/<session-id>.log`（纯 `fs` append） |
| 测试 | Vitest |

## 11. 非目标（v1 不做）

- WebUI（仅占位目录）
- 会话切换多后端（仅 JSON）
- MCP、子 agent、规划模型
- OpenAI 以外的协议实现（架构预留多协议，v1 只实现 OpenAI）
- `grep` / `glob` 工具（v1 砍掉，后续再加）
- 精确 token 计数（用粗略估算；Compaction 阈值也用估算）

## 12. 测试策略

| 范围 | 方式 |
|---|---|
| LLM 流式解析器 | 喂 mock SSE，断言归一化事件（含 tool_call 参数分片拼接、reasoning→thought_delta） |
| 工具 | 临时目录实测 read/write/edit/shell 的边界 |
| 权限 | 三桶分类 + 运行时四决策 |
| 配置 | schema 合法/非法样例 |
| Agent Loop | 注入 fake ProviderAdapter（脚本化返回 tool_calls），不联网 |
| LLM 重试 | 注入失败 N 次的 fake provider，断言重试后成功 / 超限报错 |

## 13. TUI 界面设计

**架构**：TUI 有独立的「视图态」，叠加在后端 10 态之上；TUI = 后端事件流 + UI 本地视图态的纯函数（Ink 渲染）；运行在备用屏幕（full-screen）中，避免污染终端滚动条。视图态：`chat`（默认）、`permission`（弹层）、`session` / `model`（选择器）、`config`（编辑器）、`info`（只读面板）。

**布局**（启动即显示顶部品牌条 + 欢迎语；消息在专用圆角视口内以消息卡呈现，支持滚动）：

```
🐶🥚 DogEggAgent v0.1.0 · openai/gpt-4o
  🥚 你    帮我修登录 bug
  🐶 助手  让我先看下代码…
  🐾 工具  read_file ✓ 342 行
  🐶 助手  问题在 line 42，改成这样…
  ▌ （流式）
──────────────────────────────────
🐶🥚 responding
› ▌
```

**组件与交互**：

| 组件 | 说明 | 键位 |
|---|---|---|
| 消息列表 | 每条消息为**左色条块**（无全框，靠左侧色条 + marginBottom 留白分隔）：用户、思考、助手、工具（调用+结果合一）各自成块；思考块与工具结果**默认折叠**（思考折叠显示前 3 行摘要、工具折叠显示前 120 字符摘要，展开显示全文/完整结果），`↑`/`↓` 在可折叠块间移动焦点（accent 左色条 + ▸ 高亮），`回车` 展开/折叠、`Esc` 返回输入框；无可折叠块时 `↑`/`↓` 滚动历史，`PageUp`/`PageDown` 翻页，`scroll=0` 时自动跟随最新；底部显示滚动提示。⚠️ resume 加载历史会话时工具块可折叠（full 从持久化的 tool 消息 content 重建），但思考块不可恢复——思考内容来自流式 `thought_delta`、不持久化进 history，resume 后无思考块（固有限制） | — |
| 输入框 | 多行缓冲 | `Enter` 发送 / `Ctrl+Enter` 换行（终端发送 `\n` 被 ink-text-input 当普通字符插入）/ `↑↓` 召回输入历史（无可折叠块时）/ `Ctrl+C` 运行中打断当前操作（发 cancel，不退出）/ 空闲时弹退出确认 / `PageUp`/`PageDown` 滚动历史 / `/` 命令联想补全：输入 `/` 前缀时上方显示匹配命令列表（命令名+描述，前缀匹配），`↑↓` 选择、`Enter`/`Tab` 补全命令到输入框（不补全描述，不直接运行，需再按 `Enter` 提交）、`Esc` 取消 |
| 状态栏 | `<品牌> <Emoji+Braille spinner> <状态文字> · provider/model · #sessionId · tokens/window`；运行态（thinking/responding/executing/compacting）显示 Braille spinner 旋转动画（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 循环，80ms/帧）+ 对应状态 Emoji；非运行态（idle/finished/cancelled/error/waiting_permission）静态显示。状态来自后端 `state` 事件 | — |
| 权限弹层 | 工具变更预览（edit_file 显示 `- old_string` / `+ new_string` 红绿 diff；write_file 显示 `+ content`；shell 显示命令）+ 三行列表：允许一次 / 始终允许 / 拒绝 | `↑↓` 选、`Enter` 确认、`Esc` 拒绝 → `permission_decision` |
| 会话选择器 | 列 session，选一个恢复 | `↑↓` 选、`Enter` 确认、`Esc` 返回 |
| 模型选择器 | provider → model 两级 | 同上 |
| 配置编辑器 | 字段类型驱动的 6 种编辑动作 | 见下 |
| 信息面板 | /context /tools /system /status /log /help，只读 overlay（圆角框 + 标题 + 内容行） | `↑↓` 翻页、`Esc` 关闭 |

**配置编辑器（树形表单）**：把 config 的 JSON 结构渲染成一棵可上下导航的树，`Enter` 钻入、`Esc`/`←` 返回上一层。

| 字段类型 | 交互 |
|---|---|
| 标量（字符串/数字） | 回车就地输入，保存后**留在原位**、手动返回 |
| 布尔（reasoning） | `←→` 切换候选、回车确认 |
| 对象（permission / provider / model） | 回车钻入子字段 |
| 数组（providers / models / 三桶） | 回车进列表；`＋ 添加` 创建空节点再自由填；选中按 `d` 删、钻入底部也有删除项 |
| 选中即设（defaultProvider / defaultModel） | 钻入列表、回车选中即设 |

每个动作最终翻译成 `config_set` / `config_add` / `config_remove`；是否「配置完整到可提问」由 `isConfigured()` 判定。

### 界面示例

**主布局（消息流 / 工具 / 流式）**：

```text
╭─ 🥚 你 ───────────────────────────────────────╮
│  帮我修一下登录的 bug                        │
╰────────────────────────────────────────────╯

╭─ 🐣 思考（折叠 · 仅推理模型）───────────────────╮
│  先定位登录流程，再看 token 校验…             │
╰────────────────────────────────────────────╯

╭─ 🐶 助手 ─────────────────────────────────────╮
│  让我先看下相关代码。                        │
╰────────────────────────────────────────────╯

╭─ 🐾 工具 · read_file ✓ ────────────────────────╮
│  参数：src/auth.ts                           │
│  结果：342 行 · 1.2s（折叠，展开看全文）        │
╰─────────────────────────────────────────────╯

╭─ 🐶 助手 ─────────────────────────────────────╮
│  问题在 src/auth.ts:42，改成这样…            │
╰────────────────────────────────────────────╯

╭─ 🐶 助手（流式）───────────────────────────────╮
│  正在生成… ▌                               │
╰────────────────────────────────────────────╯
----------------------------------------------
状态栏   🐶🥚 [responding] openai/gpt-4o · #3f2a · 12k/128k
输入框   > ▌
```

**`/session` 会话选择器**：

```text
[面板] 会话选择
----------------------------------------------
  > 3f2a   今天 14:02   帮我修登录 bug
    1ab9   昨天 09:41   重构 config 模块
    0c77   昨天 20:12   写工具说明
----------------------------------------------
  up/down 选择 · 回车切换 · esc 返回
```

**`/model` 模型选择器（两级）**：

```text
[面板] 选择模型
----------------------------------------------
  Provider:  > openai
               deepseek
  Model:     * gpt-4o      (当前)
               gpt-4o-mini
----------------------------------------------
  up/down 选择 · 回车确认 · left/esc 返回
```

**`/config` 配置编辑器（树形，根层 → 钻入 providers）**：

```text
[面板] 配置 / root
----------------------------------------------
  > systemPrompt      （空）
    defaultProvider   （未选择）
    defaultModel      （未选择）
    maxIterations     50
    maxRetries        3
    permission        allow/reject/ask
    providers         0 个
----------------------------------------------
  up/down 选择 · 回车钻入/编辑 · esc 返回

[面板] 配置 / providers
----------------------------------------------
  > openai            https://api.openai.com/v1
    ＋ 添加 provider
----------------------------------------------
  up/down · 回车钻入 · d 删 · esc 返回
```

**`/context` 上下文占用**：

```text
[面板] 上下文
----------------------------------------------
  12,300 / 128,000 tokens  (9%)
  [######····················]
  下次压缩阈值：80%（102,400）
----------------------------------------------
  esc 关闭
```

**`/tools` 工具列表**：

```text
[面板] 工具
----------------------------------------------
  read_file    读取文件内容
  write_file   整文件覆写/创建
  edit_file    old_string -> new_string 精准替换
  shell        执行 shell 命令（解释器可配）
----------------------------------------------
  esc 关闭
```

**`/system` system prompt**：

```text
[面板] system prompt
----------------------------------------------
  路径：~/.dogegg/prompts/system.md
  ----------------------------------------
  你是一个代码 agent，负责…（正文，可滚动）
----------------------------------------------
  esc 关闭
```

**`/status` 状态一览**：

```text
[面板] 状态
----------------------------------------------
  session   #3f2a
  provider  openai
  model     gpt-4o
  cwd       D:\project\DogEggAgent
  state     responding
  context   12,300 / 128,000 (9%)
----------------------------------------------
  esc 关闭
```

**`/log` 调试日志**：

```text
[面板] 日志
----------------------------------------------
  路径：~/.dogegg/logs/3f2a.log
  ----------------------------------------
  14:02:01  [llm]   POST /chat/completions
  14:02:03  [tool]  read_file src/auth.ts ok
  14:02:05  [state] executing -> responding
  …（尾部若干行，可滚动）
----------------------------------------------
  esc 关闭
```

**`/clear` / `/quit` 确认弹层**：

```text
[面板] 确认
----------------------------------------------
  清空当前会话历史？此操作不可撤销。
----------------------------------------------
  回车 确认    esc 取消

[面板] 确认
----------------------------------------------
  退出 DogEggAgent？
----------------------------------------------
  回车 退出    esc 取消
```

**`/compact` 压缩结果**：

```text
[面板] 压缩上下文
----------------------------------------------
  压缩前：98,000 tokens · 压缩后：21,400 tokens
----------------------------------------------
  esc 关闭
```

**`/help` 命令列表**：

```text
[面板] 帮助
----------------------------------------------
  /new 新建会话      /config 编辑配置
  /session 切换会话   /model 快速切模型
  /clear 清空历史     /compact 手动压缩
  /context 查看占用   /tools 列出工具
  /system 系统提示词  /status 状态一览
  /log 调试日志       /quit 退出       /help 本帮助
----------------------------------------------
  esc 关闭
```

## 14. 视觉设计系统

**主题**：Catppuccin Mocha（暗色）。图标用**基础 Unicode + 系统 emoji**（不依赖 Nerd Font）。

**原则**：克制用色；层级靠 bold / dim / accent 建立；状态色语义化且低饱和；同类信息同色同字形；面板用**圆角线框**分隔。

**色彩角色**：

| 角色 | 色值 | ANSI | 用途 |
|---|---|---|---|
| 背景 | `#1e1e2e` | — | 终端底色 |
| 正文 | `#cdd6f4` | default | 助手回答、普通文本 |
| 次要 | `#6c7086` | dim | 时间戳、路径、面板边框、meta |
| accent | `#89b4fa` | blue | 光标、选中项、活动元素、输入框 |
| 成功 | `#a6e3a1` | green | `finished`、工具 ✓ |
| 等待 | `#f9e2af` | yellow | `waiting_permission`、reasoning |
| 工具 | `#94e2d5` | cyan | `executing` 的 `⚙` + spinner |
| 错误 | `#f38ba8` | red | `error`、✕ |

**状态 → 颜色/图标/Spinner**：

| 状态 | 颜色 | Emoji | Braille Spinner | 说明 |
|---|---|---|---|---|
| `idle` | dim | 🥚 | — | 静止，蛋等主人 |
| `thinking` | yellow | 🐣 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 蛋孵化中，spinner 旋转 |
| `responding` | accent | 🐶 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 狗在回答，spinner 旋转 |
| `tool_calling` / `executing` | cyan | 🐾 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 狗爪动手，spinner 旋转 |
| `waiting_permission` | yellow | ⚠ | — | 静止，等待用户审批 |
| `finished` | green | 🐥 | — | 孵出小鸡，完成 |
| `cancelled` | dim | 🥚 | — | 静止，已打断 |
| `error` | red | 🐶 | — | 静止，汪！出错了 |
| `compacting` | cyan | 🥚 | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 蛋压缩中，spinner 旋转 |

Spinner 帧序列 10 帧循环，80ms/帧（12.5fps），完整一圈 800ms。运行态启动定时器，非运行态停止。格式：`<Emoji> <Braille帧> <状态文字>`。

**字形层次**：用户 🥚、助手 🐶、思考 🐣、工具 🐾 作为块头图标；正文 default、reasoning 折叠后 dim；工具块 cyan + dim 摘要；选中项反色（inverse）；面板圆角 dim 边框、标题 bold accent。

**组件**：每条消息 = 左色条块（用户块 accent、思考块 yellow、助手块 default、工具块 cyan 调用+结果合一），无全框靠 marginBottom 留白分隔；状态栏底色块 + 彩色状态点 + bold；输入框 accent `›` 前缀、聚焦时下划线；进度条 accent 填充 + dim 底；动效（流式光标闪烁、spinner 转动，流式消息块随文本增长）。

**标注示例**（注释即 ANSI 色）：

```text
┌─ 消息列表 ────────────────────────────────┐   dim 圆角框
│  > 帮我修登录 bug                          │   bold + accent
│  ⚙ read_file src/auth.ts      ✓           │   cyan + dim + green，✓ 绿
└───────────────────────────────────────────┘
● 🐶 ⠹ responding · openai/gpt-4o · #3f2a · 12k/128k   状态栏，表面色底，● accent，spinner 旋转
> ▌                                                accent 输入光标
```

### 狗蛋品牌元素（全开）

「狗蛋」人格：🐶 狗 = 助手/本体，🥚 蛋 = 用户/主人，两者成对即「狗蛋」。

**块角色头**：

| 块 | 图标 | 含义 |
|---|---|---|
| 用户 | 🥚 | 蛋 = 主人 |
| 助手 | 🐶 | 狗 = 本体 |
| 思考 | 🐣 | 蛋孵化 = 思路成型 |
| 工具 | 🐾 | 狗爪 = 动手 |

**其它场景**：

| 场景 | 元素 |
|---|---|
| 启动 banner | `🐶🥚  DogEggAgent v0.1.0` |
| 状态栏前缀 | `🐶🥚` |
| `idle` | 🥚 |
| `finished` | 🐥（孵出小鸡） |
| `error` | `🐶 汪！出错了` |
| spinner | 🐾 步态（执行）/ 🐣 孵化（思考） |

**规则**：emoji 是双宽字符，只放角色头 / 状态栏 / banner 等固定位置，不嵌流式正文，避免破坏 markdown 排版与框线对齐（Ink 渲染时会正确对齐，文档 mockup 的框线仅为示意）。