# 01 · 整体架构与多包解耦

## 为什么需要解耦

一个 code agent 天然有两半：

- **后端**（agent）：LLM 调用、工具执行、上下文管理、会话持久化——这些和怎么展示无关。
- **前端**（ui）：消息渲染、键盘交互、配置编辑器——这些和 agent 逻辑无关。

如果后端直接调前端的渲染函数、前端直接调后端的方法，两者就**耦合**了。换前端（比如将来加 WebUI）要改后端，换后端要改前端。

DogEggAgent 的解耦方案：**后端和前端互不 import，都只依赖第三个包 `bridge`（契约 + 通道）**。WebUI 额外引入 `server` 包做网络传输，但 agent 和 ui 本身一行不改。

## 四包结构

```
DogEggAgent/
├─ main.ts               # TUI 组合根（唯一同时 import agent 与 ui 的地方）
├─ main-web.ts           # WebUI 组合根（import agent + server + bridge）
├─ package.json          # workspaces: ["agent","ui","bridge","server"]
├─ agent/                # @dogegg/agent：后端域
├─ ui/                   # @dogegg/ui：前端域（tui + webui + shared）
├─ bridge/               # @dogegg/bridge：契约 + 通道
└─ server/               # @dogegg/server：HTTP + SSE + REST（WebUI 用）
```

- `@dogegg/bridge`：不依赖任何兄弟包。定义消息类型 + Config schema + Port 接口。
- `@dogegg/agent`：依赖 `@dogegg/bridge`（只用它的类型和通道）。不依赖 `@dogegg/ui`。
- `@dogegg/ui`：依赖 `@dogegg/bridge`。不依赖 `@dogegg/agent`。
- `@dogegg/server`：依赖 `@dogegg/agent` + `@dogegg/bridge`。实现 SSE channel + HTTP server + REST 端点。不 import `@dogegg/ui`（前端是静态文件被 serve）。
- 根 `main.ts`：同时 import agent 和 ui，把两者对接。`main-web.ts`：import agent + server，server serve 静态前端。

### 架构测试强制

这个规则不是口头约定——`bridge/test/architecture.test.ts` 扫描各包源码，断言：

1. `agent/src` 不得 import `@dogegg/ui`；`ui/src` 不得 import `@dogegg/agent`。
2. `bridge/src` 不得 import `@dogegg/agent` 或 `@dogegg/ui`。
3. `server/src` 不得 import `@dogegg/ui`（前端是静态文件被 serve）。
4. `index.ts` 只允许 re-export，不允许 `export const/function/class` 实现声明。

> 详见 `bridge/test/architecture.test.ts`。

## bridge 包：契约 + 通道

### 消息契约（双向 union）

后端和前端的通信全部通过消息。消息按方向分两套 union：

```ts
// bridge/src/contract/agent-to-ui.ts
// 后端 → 前端：state 迁移、流式 delta、工具事件、权限请求、会话/配置状态……
type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; error?: string }
  | { type: 'permission_request'; id: string; tool: string; input: unknown }
  | { type: 'error'; error: { message: string; name?: string } }
  | ... // 共 22 个变体

// bridge/src/contract/ui-to-agent.ts
// 前端 → 后端：提交消息、取消、权限决策、会话管理、配置编辑……
type UiToAgentMessage =
  | { type: 'submit'; text: string }
  | { type: 'cancel' }
  | { type: 'permission_decision'; id: string; decision: PermissionDecision }
  | { type: 'config_set'; path: string; value: unknown }
  | ... // 共 18 个变体
```

两套都是**可序列化的纯数据**（没有函数、没有 Error 对象）。这样将来接 SSE 时，序列化/反序列化的就是这些类型，不用改 agent 和 ui。

### Config schema

Config 的 zod schema 也放在 bridge——它是跨边界的共享事实源：

```ts
// bridge/src/contract/config.ts
export const configSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  maxIterations: z.number().int().positive().default(50),
  permission: permissionSchema.default({ allow: [], reject: [], ask: [] }),
  providers: z.array(providerSchema).default([]),
  ...
})
```

agent 做加载与编辑，ui 做类型消费与渲染，两者用的都是 bridge 里的同一个 schema——永不漂移。

### Port 通道

Port 是 bridge 唯一的新抽象——把「两端怎么通信」从具体传输中抽离：

```ts
// bridge/src/channel/port.ts
export interface AgentPort {
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void  // 订阅 + 返回退订
  post(msg: AgentToUiMessage): void                              // 发后即忘
}
export interface UiPort { /* 镜像 */ }
```

关键设计：**`post()` 没有返回值**。即使在同进程内，前端也不能 `await agent.someMethod()`。这强制了消息边界——所有交互都是异步消息，不是函数调用。

同进程实现（`in-memory.ts`）用两个 `Set<listener>` 同步投递：

```ts
// bridge/src/channel/in-memory.ts
agentPort.post(msg) → uiListeners.forEach(l => l(msg))  // 同步扇出
uiPort.post(msg)    → agentListeners.forEach(l => l(msg))
```

将来接 WebUI 时，在 server 包新增 `sse.ts`（SSE 下行 + POST 上行）实现同样的 Port 接口，agent 和 ui 一行不改。server 包归 server 域而非 bridge 契约域（ADR-0002）。

## 组合根：main.ts / main-web.ts

TUI 组合根（`main.ts`），全项目唯一同时 import agent 和 ui 的文件，约 25 行：

```ts
// main.ts
const config = loadConfig()                        // @dogegg/agent
const { agentPort, uiPort } = createChannelPair()  // @dogegg/bridge
initLogger(join(homedir(), '.dogegg', 'logs'))     // @dogegg/agent
new Agent(agentPort, config, process.cwd())        // 构造时自订阅 port
renderTui(uiPort)                                  // @dogegg/ui
```

WebUI 组合根（`main-web.ts`），import agent + server（不 import ui——前端是静态文件）：

```ts
// main-web.ts
const config = loadConfig()
const { agentPort, uiPort, sseHandler, postHandler } = createSseChannel()  // @dogegg/server
initLogger(join(homedir(), '.dogegg', 'logs'))
new Agent(agentPort, config, process.cwd())
startServer({ uiPort, sseHandler, postHandler, staticDir, port: 3000 })    // @dogegg/server
```

组合根不含业务逻辑，只做接线。Agent 构造时 `this.port.onMessage(cb)` 自订阅——之后一切由 port 消息驱动。

## 模块 = 文件夹

每个模块都是一个文件夹，`index.ts` 是唯一对外脸面（纯 re-export）。文件夹内其它文件是私有实现。跨模块 import 只指向 `index.ts`。

例如 tools 模块：

```
tools/
├─ index.ts              # 纯 re-export: getAllTools / getTool / toolSchemas / types
├─ registry.ts           # 实现: 静态工具注册表
├─ types.ts              # Tool / ToolContext / ToolResult 契约
├─ read_file/
│  ├─ index.ts           # 组装 readFileTool 对象
│  ├─ schema.ts          # zod schema
│  └─ execute.ts         # 实现
├─ write_file/ ...
├─ edit_file/ ...
└─ shell/
   ├─ index.ts  ├─ schema.ts  ├─ execute.ts
   ├─ interpreter.ts      # shellProgram → {program, flag}
   └─ kill-tree.ts        # 进程树终止
```

这种结构的好处：改某个工具的实现不影响其它工具；index.ts 的导出就是模块的完整 API。
