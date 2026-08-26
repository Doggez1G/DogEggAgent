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

`agent/` 与 `ui/` 这两个目录只是「后端」与「前端」两大部分的代称——边界不在字面的这两个文件夹，而在「后端逻辑」与「前端展示」之间。

实现方式：
- `events/` 是唯一的解耦契约（纯类型：按方向拆成两套消息类型 `AgentToUiMessage` / `UiToAgentMessage`，见 §6）。
- 后端不 import 前端，前端不 import 后端。
- 两者仅在 `main/bootstrap.ts`（组合根）中通过消息对接。
- 两类消息都是**传输无关**的单一事实源：v1 同进程内用 EventEmitter 投递；将来 WebUI 加 SSE 传输层，复用同一套消息类型，不必推倒重来。

消息分两层，职责不同，不可混淆：

1. **LLM 级 StreamEvent**（`llm/types.ts`）：provider → agent loop 的流，表达「模型吐了什么」。
2. **Agent 级消息**（`events/`）：后端 ↔ 前端，按方向分成 `out`（后端→前端）与 `in`（前端→后端）两套 union。

## 3. 需求清单

| # | 需求 | 关键决定 |
|---|---|---|
| 1 | Agent Loop | 从零手写；工具**串行**执行；`while`: 问模型 → 有 tool_calls 则串行执行 → 结果回填 → 再问 → 无 tool_calls 结束 |
| 2 | Tool Calling | 模型返回 tool_calls，Core 按 schema 本地执行，串行 |
| 3 | Context | 每次发给模型 = System Prompt + 处理后的历史 + 工具 schema，受窗口预算约束 |
| 4 | Message History | 有序消息列表，**原样持久化**，与 Context 分开管理 |
| 5 | System Prompt | 配置只存**文件路径**，缺省用内置默认文件，用户改文件即可自定义 |
| 6 | Tool Result | 超长结果截断，cap ≈ 8000 字符（截断处注明） |
| 7 | Context Window | 来自**模型配置** `contextWindow`，缺省保守 128k |
| 8 | Agent State | 9 态状态机（见 §4） |
| 9 | Event System | 见 §2 |
| 10 | Permission | 配置 `allow/reject/ask` 三桶 + 运行时 `allow_once/allow_always/reject`（见 §5） |
| 11 | Session | Session ID / 消息持久化 / Resume / History；JSON：`~/.dogegg/sessions/<id>.json`；REPL 斜杠命令 `/new`、`/session`（列会话并选择切换）管理 |
| 12 | Context Compaction | LLM 把旧历史压成 summary；触发 80% 窗口、保留最近 4 条原文 |
| 13 | UI | Message List / Markdown / Tool Call / Tool Result / Input / Status Bar / Streaming |

- **Reasoning**：v1 要接入推理模型，思考内容走独立 `thought_delta` 事件，按 OpenAI 官方标准字段解析。⚠️ 具体字段名（`reasoning_content` 等）在实现时对照 OpenAI 当前文档确认，不在此写死。

**运行时行为（增补）**：

- **cwd**：以启动 agent 时所在目录为工作目录；无 CLI 参数、无配置项。
- **运行时切换 provider/model**：通过 `/model`（快速）或 `/config`（完整编辑）。
- **LLM 错误重试**：请求失败自动重试 `maxRetries` 次（缺省 3），仍失败则报错给 UI。
- **调试日志**：每轮消息流 / 工具调用 / 状态迁移追加写到 `~/.dogegg/logs/<session-id>.log`。
- **CLI 参数**：v1 无（一切通过 REPL 斜杠命令）。

## 4. 状态机（9 态）

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
waiting_permission ──reject（回填 denied）──▶ thinking | responding
executing ──结果回填，重新请求──▶ thinking | responding
任意运行态 ──cancel──▶ cancelled
任意运行态 ──error──▶ error
finished / cancelled / error ──▶ idle
```

## 5. 权限模型（两层）

**配置层（静态分类）**：

| 配置桶 | 含义 |
|---|---|
| `allow` | 自动放行，不询问 |
| `reject` | 永远拒绝 |
| `ask` | 每次询问 |

**运行时层（仅 `ask` 桶命中时）**：用户决策三值：

- `allow_once`：仅放行本次调用
- `allow_always`：将工具在本会话内挪入允许
- `reject`：拒绝本次调用（回填 denied，继续）

审批通过注入的回调交给 UI（TUI = await Y/n），`agent/permission` 本身不依赖 UI。

## 6. 消息契约

**LLM 级 StreamEvent**（`llm/types.ts`，provider → agent loop）：

```
text_delta / thought_delta / tool_call_start / tool_call_delta / tool_call_end / done / error
```

其中 `thought_delta` 承载 reasoning 内容，`text_delta` 承载答案文本，UI 可据此把「思考」与「回答」分开展示。这是后端内部更底层的一层。

**Agent 级消息**（`events/`，后端 ↔ 前端）：按方向拆成两套 union，便于维护；两套都是「消息」，不是「事件 vs 命令」。将来接 SSE 时，序列化/反序列化的正是这两套类型。

```ts
// out: 后端 → 前端
type AgentToUiMessage =
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

要点：
- `permission_request`（out）与 `permission_decision`（in）通过 `id` 配对。
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
  parameters: JsonSchema       // OpenAI function schema
  execute(args, ctx): Promise<ToolResult>   // ctx: cwd / permission / emit
}
```

`tools/registry.ts` 汇总所有工具的 `name/schema/execute`。工具参数（LLM 返回的 JSON）用 **zod** 校验。

**`shell` 与取消（cancel）**：
- `shell` 的解释器可配置（Windows 默认 `cmd`，可切 `powershell`/`bash`），通过 `spawn(interp, [flag, cmd])` 显式指定。
- `shell` 返回一个**可 kill 的进程句柄** `{ pid, kill() }`，不是跑完就丢。
- 取消三件套：`AbortController` 中断 LLM 请求 + 工具之间检查取消标志 + 杀 shell 进程树。
- `kill()` 按 OS 分支：`win32` 用 `taskkill /PID <pid> /T /F`（杀整棵树，对 cmd/powershell/bash 通用）；POSIX 用 detached 进程组 + `process.kill(-pid, 'SIGKILL')`。杀进程**不按 shell 类型**区分，只按 OS。

## 9. 目录结构

```
DogEggAgent/
├─ src/
│  ├─ main/
│  │  ├─ index.ts            # 进程入口（package.json bin 指向此处）
│  │  └─ bootstrap.ts        # 组合根：后端消息 ↔ 前端渲染接线
│  ├─ events/
│  │  ├─ agent-to-ui.ts      # AgentToUiMessage 联合类型（后端 → 前端）
│  │  └─ ui-to-agent.ts      # UiToAgentMessage 联合类型（前端 → 后端）
│  ├─ agent/                 # Agent Core（后端核心）
│  │  ├─ index.ts            # Agent 类：emit 消息 / 收消息
│  │  ├─ loop/               # 循环编排
│  │  ├─ state/              # 9 态 + transition() 纯函数
│  │  ├─ history/            # Message History（原样持久化）
│  │  ├─ context/            # system prompt 组装 / 窗口预算 / Compaction
│  │  ├─ session/            # ID / JSON 持久化 / Resume
│  │  └─ permission/         # 三桶分类 + 运行时决策
│  ├─ llm/                   # LLM 接入
│  │  ├─ types.ts            # ChatRequest / LLM StreamEvent / ProviderAdapter
│  │  ├─ provider/           # OpenAIAdapter + ProviderRegistry（多实例）
│  │  └─ streaming/          # SSE → StreamEvent（含 reasoning_content → thought_delta）
│  ├─ tools/                 # 工具
│  │  ├─ types.ts            # Tool 接口
│  │  ├─ registry.ts
│  │  └─ read_file/ write_file/ edit_file/ shell/
│  ├─ config/                # schema.ts / loader.ts
│  ├─ common/                # utils/（id、token 估算、截断、logger）+ errors.ts（跨域共享）
│  └─ ui/                    # 前端：只消费/发送 AgentMessage
│     ├─ tui/                # Ink：MessageList / Input / StatusBar / PermissionPrompt / SessionPicker / ModelPicker / ConfigEditor / InfoPanel
│     └─ webui/              # 占位（v1 不实现）
└─ test/                     # 镜像 src/ 的域结构，*.test.ts
   ├─ agent/  llm/  tools/  config/  common/
```

**依赖约束（唯一硬约束）**：

- 后端与前端互不 import，仅通过 `events/` 的消息类型关联。这是解耦原则的实体化。
- 除此之外，各域之间谁依赖谁属于实现细节，不在本文档中钉死为规范。

## 10. 技术选型

| 项 | 选择 |
|---|---|
| LLM 传输 | 原生 `fetch`（Node≥20）+ 手写 SSE 解析（读 `response.body` 流） |
| 校验 | **zod**（配置 + 工具参数 + 消息结构，全部） |
| 持久化 | JSON 文件 |
| TUI | Ink（`ink` + `ink-text-input`） |
| Markdown 渲染 | `marked` + `marked-terminal`（成熟现成，不自研） |
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

**架构**：TUI 有独立的「视图态」，叠加在后端 9 态之上；TUI = 后端事件流 + UI 本地视图态的纯函数（Ink 渲染）。视图态：`chat`（默认）、`permission`（弹层）、`session` / `model`（选择器）、`config`（编辑器）、`info`（只读面板）。

**布局**：

```
消息列表（可滚动，占大部分）
状态栏：⏺ responding · openai/gpt-4o · #3f2a · 12k/128k
输入框：› ▌
```

**组件与交互**：

| 组件 | 说明 | 键位 |
|---|---|---|
| 消息列表 | 每条消息为一**独立圆角块**：用户块、思考块、助手块、工具块（调用+结果合一）各自成块（带角色头）；思考块（仅推理模型）与工具块默认折叠、可展开；流式时块随文本增长 | — |
| 输入框 | 多行缓冲 | `Enter` 发送 / `Shift+Enter` 换行 / `↑↓` 历史 / `/` 命令补全 |
| 状态栏 | `state 图标 · provider/model · #sessionId · tokens/window`，state 来自后端 `state` 事件 | — |
| 权限弹层 | 三行列表：允许一次 / 始终允许 / 拒绝 | `↑↓` 选、`Enter` 确认、`Esc` 拒绝 → `permission_decision` |
| 会话选择器 | 列 session，选一个恢复 | `↑↓` 选、`Enter` 确认、`Esc` 返回 |
| 模型选择器 | provider → model 两级 | 同上 |
| 配置编辑器 | 字段类型驱动的 6 种编辑动作 | 见下 |
| 信息面板 | /context /tools /system /status /log /help，只读 | `Esc` 关闭 |

**配置编辑器**：根据光标所在字段类型选择编辑动作：

| 动作 | 字段 | 键位 |
|---|---|---|
| `drill` 钻入 | 对象/数组（providers、permission、models） | `→`/`Enter` |
| `text-input` | systemPrompt、baseURL、apiKey、name | 输入 + `Enter` |
| `number-input` | maxIterations、maxRetries、contextWindow、maxOutput | 输入 + `Enter` |
| `enum-cycle` | protocol、reasoning | `←→` |
| `select-from-list` | defaultProvider、defaultModel | `↑↓` + `Enter` |
| `toggle-set` | permission 三桶工具名 | 空格勾选 + `Enter` |

通用导航：`↑↓` 字段移动、`→`/`Enter` 进入、`←`/`Esc` 返回；列表内 `d` 删、`a` 增。每个动作最终翻译成 `config_set` / `config_add` / `config_remove`（path 由 UI 依光标位置算出，用户不手打）。

### 界面示例

**主布局（消息流 / 工具 / 流式）**：

```text
╭─ 你 ───────────────────────────────────────╮
│  帮我修一下登录的 bug                        │
╰────────────────────────────────────────────╯

╭─ 思考（折叠 · 仅推理模型）───────────────────╮
│  先定位登录流程，再看 token 校验…             │
╰────────────────────────────────────────────╯

╭─ 助手 ─────────────────────────────────────╮
│  让我先看下相关代码。                        │
╰────────────────────────────────────────────╯

╭─ 工具 · read_file ✓ ────────────────────────╮
│  参数：src/auth.ts                           │
│  结果：342 行 · 1.2s（折叠，展开看全文）        │
╰─────────────────────────────────────────────╯

╭─ 助手 ─────────────────────────────────────╮
│  问题在 src/auth.ts:42，改成这样…            │
╰────────────────────────────────────────────╯

╭─ 助手（流式）───────────────────────────────╮
│  正在生成… ▌                               │
╰────────────────────────────────────────────╯
----------------------------------------------
状态栏   [responding] openai/gpt-4o · #3f2a · 12k/128k
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

**`/config` 配置编辑器（根 → 钻入 General）**：

```text
[面板] 配置
----------------------------------------------
  > Providers    openai / deepseek
    Permission  allow:[read_file]  ask:[write_file, edit_file, shell]
    General     systemPrompt / defaultModel / maxRetries / …
----------------------------------------------
  up/down 移动 · right 进入 · esc 返回 · d 删 · a 加

[面板] 配置 > General
----------------------------------------------
    systemPrompt      ~/.dogegg/prompts/system.md   <- 光标在此，Enter 出输入框
    defaultProvider  openai          (select-from-list)
    defaultModel     gpt-4o          (select-from-list)
    maxIterations    50              (number-input)
    maxRetries       3               (number-input)
----------------------------------------------
  up/down 移动 · Enter 编辑 · esc 返回
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

**主题**：Catppuccin Mocha（暗色）。图标用**基础 Unicode**（未依赖 Nerd Font）。

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

**状态 → 颜色/图标**：

| 状态 | 颜色 | 指示 |
|---|---|---|
| `idle` | dim | `○` |
| `thinking` | yellow | `◐`（转动） |
| `responding` | accent | `●` 闪烁 |
| `tool_calling` / `executing` | cyan | `⚙` + spinner |
| `waiting_permission` | yellow | `⚠` |
| `finished` | green | `✓` |
| `cancelled` | dim | `○` |
| `error` | red | `✕` |

**字形层次**：用户 `▸` bold + accent；助手正文 default、reasoning 折叠后 dim；工具 `⚙` cyan + dim 摘要；当前选中项反色（inverse）；面板圆角 dim 边框、标题 bold accent。

**组件**：每条消息 = 独立圆角块（用户块 accent、思考块 yellow、助手块 default、工具块 cyan 调用+结果合一）；状态栏表面色底 + 彩色状态点 + bold；输入框 accent `›` 前缀、聚焦时下划线；进度条 accent 填充 + dim 底；动效（流式光标闪烁、spinner 转动，流式消息块随文本增长）。

**标注示例**（注释即 ANSI 色）：

```text
┌─ 消息列表 ────────────────────────────────┐   dim 圆角框
│  > 帮我修登录 bug                          │   bold + accent
│  ⚙ read_file src/auth.ts      ✓           │   cyan + dim + green，✓ 绿
└───────────────────────────────────────────┘
● responding · openai/gpt-4o · #3f2a · 12k/128k   状态栏，表面色底，● accent
> ▌                                                accent 输入光标
```