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
- `events/` 是唯一的解耦契约（纯类型：`AgentEvent` 与 `AgentCommand`）。
- 后端不 import 前端，前端不 import 后端。
- 两者仅在 `main/bootstrap.ts`（组合根）中通过事件/命令对接。

事件分两层，职责不同，不可混淆：

1. **LLM 级 StreamEvent**（`llm/types.ts`）：provider → agent loop 的流，表达「模型吐了什么」。
2. **Agent 级事件/命令**（`events/`）：后端 ↔ 前端，表达「agent 在做什么」。

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
| 11 | Session | Session ID / 消息持久化 / Resume / History；JSON：`~/.dogegg/sessions/<id>.json` |
| 12 | Context Compaction | LLM 把旧历史压成 summary；触发 80% 窗口、保留最近 4 条原文 |
| 13 | UI | Message List / Markdown / Tool Call / Tool Result / Input / Status Bar / Streaming |

- **Reasoning**：v1 要接入推理模型，思考内容走独立 `thought_delta` 事件，按 OpenAI 官方标准字段解析。⚠️ 具体字段名（`reasoning_content` 等）在实现时对照 OpenAI 当前文档确认，不在此写死。

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

## 6. 事件 / 命令

**LLM 级 StreamEvent**（`llm/types.ts`，provider → loop）：

```
text_delta / thought_delta / tool_call_start / tool_call_delta / tool_call_end / done / error
```

其中 `thought_delta` 承载 reasoning 内容，`text_delta` 承载答案文本，UI 可据此把「思考」与「回答」分开展示。

**Agent 级事件/命令**（`events/`，core ↔ ui）：

Event（Core → UI）：

```
state { from, to } / text_delta / thought_delta / message / tool_start / tool_end
/ permission_request { id, tool, input } / session_ready { id, messages }
/ compaction { before_tokens, after_tokens } / finished / error
```

Command（UI → Core）：

```
submit { text } / permission { id, decision } / cancel
```

## 7. 配置 schema

```json
{
  "systemPrompt": "~/.dogegg/prompts/system.md",
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o",
  "maxIterations": 50,
  "permission": {
    "allow": ["read_file", "grep", "glob"],
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
- 配置文件位置：项目内 `.dogegg.json` 优先，否则 `~/.dogegg/config.json`。

## 8. 工具清单（6 个，snake_case）

| 工具 | 说明 |
|---|---|
| `read_file` | 读取文件内容 |
| `write_file` | 整文件覆写/创建 |
| `edit_file` | old_string → new_string 精准替换（code agent 核心） |
| `shell` | 执行 shell 命令，捕获 stdout/stderr/exit code |
| `grep` | 内容搜索 |
| `glob` | 文件名/路径匹配 |

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

## 9. 目录结构

```
DogEggAgent/
├─ src/
│  ├─ main/
│  │  ├─ index.ts            # 进程入口（package.json bin 指向此处）
│  │  └─ bootstrap.ts        # 组合根：core.emit↔ui.render、ui.command↔core.handle
│  ├─ events/
│  │  ├─ agent-events.ts     # AgentEvent 联合类型
│  │  └─ agent-commands.ts   # AgentCommand 联合类型
│  ├─ agent/                 # Agent Core（后端核心）
│  │  ├─ index.ts            # Agent 类：emit 事件 / 收命令
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
│  │  └─ read_file/ write_file/ edit_file/ shell/ grep/ glob/
│  ├─ config/                # schema.ts / loader.ts
│  ├─ common/                # utils/ + errors.ts（跨域共享）
│  └─ ui/                    # 前端：只消费 events、发 commands
│     ├─ tui/                # Ink：MessageList / ToolCall / ToolResult / Input / StatusBar / PermissionPrompt
│     └─ webui/              # 占位（v1 不实现）
└─ test/                     # 镜像 src/ 的域结构，*.test.ts
   ├─ agent/  llm/  tools/  config/  common/
```

**依赖约束（唯一硬约束）**：

- 后端与前端互不 import，仅通过 `events/` 的事件/命令关联。这是解耦原则的实体化。
- 除此之外，各域之间谁依赖谁属于实现细节，不在本文档中钉死为规范。

## 10. 技术选型

| 项 | 选择 |
|---|---|
| LLM 传输 | 原生 `fetch`（Node≥20）+ 手写 SSE 解析（读 `response.body` 流） |
| 校验 | **zod**（配置 + 工具参数 + 事件/命令结构，全部） |
| 持久化 | JSON 文件 |
| TUI | Ink（`ink` + `ink-text-input`） |
| 测试 | Vitest |

## 11. 非目标（v1 不做）

- WebUI（仅占位目录）
- 会话切换多后端（仅 JSON）
- MCP、子 agent、规划模型
- OpenAI 以外的协议实现（架构预留多协议，v1 只实现 OpenAI）
- 精确 token 计数（用粗略估算；Compaction 阈值也用估算）

## 12. 测试策略

| 范围 | 方式 |
|---|---|
| LLM 流式解析器 | 喂 mock SSE，断言归一化事件（含 tool_call 参数分片拼接、reasoning→thought_delta） |
| 工具 | 临时目录实测 read/write/edit/grep/glob/shell 的边界 |
| 权限 | 三桶分类 + 运行时四决策 |
| 配置 | schema 合法/非法样例 |
| Agent Loop | 注入 fake ProviderAdapter（脚本化返回 tool_calls），不联网 |