# DogEggAgent 模块化重构设计文档

> 状态：已确认，待进入实施计划
> 日期：2026-08-27
> 前置：基于 `2026-08-26-dog-egg-agent-design.md`（下称「原设计」）的 v0.1.0 实现现状

## 1. 目标与范围

将 DogEggAgent 从「单一 `src/` 目录 + 域内平铺文件」重构为 **npm workspaces 真多包** 的模块化架构，三个顶层包 `agent` / `ui` / `bridge`，各自拥有独立的 `src/` 与 `test/`、独立 `package.json`、独立 `tsconfig.json`。

**硬约束**：

1. **需求能力零变化**：原设计 §3 的 13 条需求能力不变，现有交互、快捷键、视觉、配置 schema 全部不变。本次是纯结构重构 + 边界切口，不新增特性、不砍特性。
2. **依赖方向唯一规则**：`agent` 与 `ui` 互相不知道对方存在，都只依赖 `bridge`；`bridge` 不依赖任何兄弟包。只有根 `main.ts` 同时 import agent 和 ui。此规则由架构测试强制（见 §9）。
3. **模块 = 文件夹**：每个模块都是一个文件夹，`index.ts` 是其唯一对外脸面（仅做导出，不写逻辑）；文件夹内其它文件是模块私有实现。跨模块 import 只能指向入口。
4. **文件夹内按职责分文件**：一个文件只承载一个职责，禁止「一个 ts 文件写全部功能」。
5. **文件体量红线**：`src/` 下源文件 ≤ 250 行（测试不受限），超出必须拆。
6. 严格 TS（`strict`）、禁用无类型 `any`、zod 校验、命名遵循本文档分层；注释说明非显然的「为什么」。

## 2. 依赖图

```
                    ┌─────────┐
                    │ main.ts │  组合根（根目录薄文件，~25 行）
                    └────┬────┘
                 装配 ↓  ↓ 装配
              ┌────────┐        ┌────────┐
              │ agent  │ ⇄消息⇄ │   ui   │
              └───┬────┘        └───┬────┘
                  └──────┬──────────┘
                    ┌────┴─────┐
                    │  bridge  │  契约 + 通道
                    └──────────┘
```

`agent` 与 `ui` 通过 `bridge` 里的消息契约 + 同进程通道（Port）互通，互不 import。只有组合根持有「两边如何对接」的知识。

## 3. 顶层形态：npm workspaces 真多包

```
DogEggAgent/
├─ package.json          # workspaces: ["agent","ui","bridge"]；根持有 typecheck/test/build 脚本
├─ tsconfig.base.json    # 共享 compilerOptions（strict / moduleResolution: bundler 等）
├─ tsconfig.json         # 根：extends base，只含 main.ts
├─ vitest.config.ts      # include 三个包的 test/
├─ build.mjs             # esbuild 构建（含 @dogegg/* 解析插件，见 §8）
├─ main.ts               # 组合根（见 §6）
├─ agent/                # @dogegg/agent
├─ ui/                   # @dogegg/ui
└─ bridge/               # @dogegg/bridge
```

每个包的 `package.json` 为 `"type": "module"`，`exports` 直接指向 TS 源码（`./src/index.ts`）——**包不单独构建**，类型检查、测试、打包由根一次完成。这是 workspace 的「内部包」模式：获得真包名 import 与独立包清单的收益，又不引入三套构建流水线。

各包依赖（依赖表即文档）：

| 包 | dependencies | devDependencies | 说明 |
|---|---|---|---|
| `@dogegg/bridge` | `zod` | — | 契约含 Config 的 zod schema；无运行时依赖内聚 |
| `@dogegg/agent` | `zod`, `@dogegg/bridge` | — | |
| `@dogegg/ui` | `ink`, `react`, `ink-text-input`, `marked`, `@dogegg/bridge` | `@types/react`, `@types/node` | 仅此包开 `jsx: react-jsx` |
| 根 `dogegg-agent` | `@dogegg/agent`, `@dogegg/ui`, `@dogegg/bridge` | `esbuild`, `typescript`, `vitest`, `@types/node` 等 | main.ts 的依赖 |

## 4. bridge 包：契约 + 通道

```
bridge/
├─ package.json / tsconfig.json
├─ src/
│  ├─ index.ts              # 全部公共导出
│  ├─ contract/
│  │  ├─ shared.ts          # State / PermissionDecision / ToolCall / Message（← events/types.ts）
│  │  ├─ config.ts          # Config 的 zod schema + 类型（← config/schema.ts）
│  │  ├─ agent-to-ui.ts     # AgentToUiMessage（← events/agent-to-ui.ts）
│  │  └─ ui-to-agent.ts     # UiToAgentMessage（← events/ui-to-agent.ts）
│  └─ channel/
│     ├─ port.ts            # AgentPort / UiPort 接口
│     └─ in-memory.ts       # createChannelPair()：同进程通道
└─ test/
   ├─ channel.test.ts       # 投递 / 退订 / 双向
   └─ architecture.test.ts  # 模块边界警察（见 §9）
```

**契约归 bridge 的原则**：凡是「要跨 agent/ui 边界的数据形状」都归 bridge 所有权。除了两套消息 union，`State` / `Message` / `Config` 也一并搬入——它们本就是事实上的跨界契约（消息字段引用它们）。`Config` 的 **zod schema 本体**（不只是类型）放 bridge：单一事实源，agent 做加载与编辑，ui 做类型消费与渲染，永不漂移。这是微服务「契约包带 schema（proto/avro）」的对齐。

**Port API**（本次唯一新抽象，约 60 行）：

```ts
// bridge/src/channel/port.ts
export interface AgentPort {
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void
  post(msg: AgentToUiMessage): void
}
export interface UiPort {
  onMessage(cb: (msg: AgentToUiMessage) => void): () => void
  post(msg: UiToAgentMessage): void
}
```

- `createChannelPair()` 返回 `{ agentPort, uiPort }`，同进程内同步投递——与现有 `agent.send()` / `emit` 的时序语义完全一致，保证行为不变。
- 将来 WebUI：在 bridge 新增 `sse-channel.ts`（SSE 下行 + POST 上行）实现同样的 Port 接口，agent 与 ui 一行不改。这是原设计 §2「传输无关、复用同一套消息类型」承诺的实体化。
- `post()` 发后即忘（同步、无返回值）：模仿真实消息边界，UI 从此不能 `await` agent 方法——现状 UI 本就未 await 过，无行为损失。

## 5. agent 包：后端域（按需求逐条归位）

```
agent/src/
├─ index.ts                      # 包出口：Agent / loadConfig（纯导出）
├─ core/                         # agent 核心
│  ├─ index.ts
│  ├─ agent.ts                   # Agent 类：构造装配、port 订阅、emit+日志、命令分发 switch、轮次编排
│  ├─ pending.ts                 # 挂起权限表：request/resolve/reject（Map 管理）
│  └─ state/
│     ├─ index.ts
│     ├─ events.ts               # TransitionInput 迁移输入类型
│     └─ transition.ts           # 9 态纯函数迁移表
├─ loop/                         # 需求 #1：问模型 → 串行工具 → 回填 → 再问
│  ├─ index.ts
│  ├─ types.ts                   # LoopDeps
│  ├─ run.ts                     # 主循环：迭代 / maxIterations / 取消检查 / 压缩 / 调 LLM
│  └─ tool-calls.ts              # 串行工具执行 + ToolResult 整形（参数解析校验 / 权限分支 / 逐个回填）
├─ context/                      # 需求 #3：上下文组装门面（index.ts 汇总对外 API）
│  ├─ index.ts
│  ├─ prompt/
│  │  ├─ index.ts  ├─ load.ts   # 读配置路径的 system prompt
│  │  └─ builtin.ts              # 内置默认 prompt（需求 #5）
│  ├─ message/
│  │  ├─ index.ts  ├─ truncate.ts    # 工具结果截断（需求 #6，cap 8000）
│  ├─ token/
│  │  ├─ index.ts  ├─ estimate.ts     # 字符 → token 粗估（CJK 规则）
│  │  └─ budget.ts               # system + 历史 + 工具 schema 总占用（需求 #7）
│  └─ compact/
│     ├─ index.ts  ├─ trigger.ts      # 80% 阈值判断（需求 #12）
│     ├─ split.ts                # 保留最近 4 条的切分
│     ├─ summarize.ts            # 调 LLM 压摘要
│     └─ compact.ts              # compactHistory 编排（自动 + 手动统一入口）
├─ llm/                          # LLM 接入
│  ├─ index.ts  ├─ types.ts      # LlmStreamEvent / ChatRequest / ProviderAdapter
│  ├─ provider/openai/
│  │  ├─ index.ts  ├─ adapter.ts      # openAiAdapter 组装
│  │  ├─ request.ts              # ChatRequest → HTTP body
│  │  ├─ stream.ts               # fetch + SSE 流读取循环（→ 逐行喂 parser）
│  │  └─ retry.ts                # 重试策略（AbortError 不重试）
│  └─ streaming/openai/
│     ├─ index.ts  ├─ types.ts        # SSE chunk 类型窄化形状
│     └─ parser.ts               # 行驱动解析器（分片拼接 / reasoning→thought_delta）
├─ tools/                        # 需求 #2
│  ├─ index.ts                   # registry：getAllTools / getTool / toolSchemas
│  ├─ types.ts                   # Tool / ToolContext / ToolResult 契约
│  ├─ read_file/    ├─ index.ts  ├─ schema.ts（定义）  ├─ execute.ts（实现）
│  ├─ write_file/   ├─ index.ts  ├─ schema.ts         ├─ execute.ts
│  ├─ edit_file/    ├─ index.ts  ├─ schema.ts         ├─ execute.ts
│  └─ shell/
│     ├─ index.ts  ├─ schema.ts  ├─ execute.ts
│     ├─ interpreter.ts          # shellProgram → {program, flag}（← common/utils/shell）
│     └─ kill-tree.ts            # 进程树终止（win taskkill / POSIX 进程组）
├─ session/                      # 需求 #11：持久化 / Resume / 列表
│  ├─ index.ts  ├─ store.ts      # save / load（JSON 持久化）
│  └─ list.ts                    # 会话列表 + preview
├─ permission/                   # 需求 #10：三桶 + 运行时决策
│  ├─ index.ts  ├─ classify.ts   # 三桶静态分类
│  └─ runtime.ts                 # 运行时 allow_always 会话内提升
├─ config/                       # 配置域（schema 本体在 bridge 契约里）
│  ├─ index.ts
│  ├─ loader/
│  │  ├─ index.ts  ├─ find.ts    # 配置文件定位（.dogegg.json 优先）
│  │  ├─ load.ts                 # loadConfig + 默认值填充
│  │  └─ save.ts                 # saveConfig 落盘
│  ├─ editor/
│  │  ├─ index.ts                # ConfigEditor 门面（从 Agent 抽出的 ~150 行）
│  │  ├─ paths.ts                # 点号路径文法解析（providers.<i>.models.<j>.field）
│  │  ├─ mutate.ts               # set / add / remove 对 config 对象的实际变更
│  │  └─ validate.ts             # 重校验 + 重名检查 + 回滚快照
│  └─ resolve/
│     ├─ index.ts  ├─ current.ts      # 当前 provider+model 解析（收编 ProviderRegistry）
│     └─ configured.ts           # isConfigured 完整性判定
└─ shared/                       # 跨子域支撑（仅 agent 内部使用）
   ├─ index.ts  ├─ errors.ts     # CancelledError
   ├─ id.ts                      # 短 id
   └─ logger/
      ├─ index.ts  ├─ init.ts    # 日志目录初始化
      ├─ write.ts                # 追加写
      └─ tail.ts                 # /log 尾部读取
```

**需求 → 模块映射**（拆分骨架，每条需求唯一归宿）：

| 需求（原设计 §3） | 归宿 |
|---|---|
| #1 Agent Loop | `loop/` |
| #2 Tool Calling | `tools/`（执行由 loop 串行驱动） |
| #3 Context 组装 | `context/`（门面） |
| #4 Message History | `core` 持有 + `session/` 持久化；**不放 context**，保住「历史与上下文分离」 |
| #5 System Prompt | `context/prompt/` |
| #6 Tool Result 截断 | `context/message/` |
| #7 Context Window | `context/token/` |
| #8 Agent State | `core/state/` |
| #10 Permission | `permission/` |
| #11 Session | `session/` |
| #12 Compaction | `context/compact/` |
| 配置 | `config/`（schema 本体在 bridge 契约） |

**拆分说明（相对早期草案的两处微调）**：

- `core/` 不设 `commands.ts` / `turn.ts`——命令分发与轮次编排是 Agent 自身的唯一接缝，硬拆成游离函数需引入薄而散的 context 对象，反而降低可维护性；真正可独立的大块（配置编辑、provider 解析、挂起权限）已拆出为独立模块。
- `context/message/` 仅保留 `truncate.ts`——`ToolResult` 类型归 tools 域，若把结果整形放 context 会引入 context→tools 依赖，破坏依赖矩阵；该整形逻辑归 `loop/tool-calls.ts`（其唯一消费方）。

**拆分顺带修掉的重复（不只是搬家）**：

- **压缩逻辑统一**：现状 loop 内联做自动压缩、`Agent.compactNow` 又重写一遍手动压缩。统一为 `context/compact/compact.ts` 的 `compactHistory()`，loop 与 `/compact` 都调它。
- **provider/model 解析统一**：`ProviderRegistry`、`isConfigured`、`Agent.currentProvider/currentModel` 三处各写一遍「从 config 找当前 provider+model」。统一为 `config/resolve/`，`ProviderRegistry` 类消解。
- **Agent 瘦身**：351 行 → 约 200 行纯门面（配置编辑 150 行进 `config/editor`）。
- **agent 构造签名**：`new Agent({ port, config, cwd, logDir })`，内部自订阅 port 消息；`on()/send()` 公共方法删除——agent 只有消息这一个进出通道；`emit()` 内部改为 `port.post()`（日志埋点原样保留）。

## 6. ui 包：前端域（按组件逐个成模块）

```
ui/src/
├─ index.ts                      # 包出口：renderTui（纯导出）
└─ tui/
   ├─ index.ts
   ├─ app/                       # 应用装配层
   │  ├─ index.ts
   │  ├─ app.tsx                 # App 组件：状态持有 + 渲染骨架 + 键盘路由 + 输入框 + 覆盖层渲染（装配，纯渲染分支）
   │  ├─ view-state.ts           # View 视图态联合（弹层状态机，纯）
   │  └─ entry.ts                # renderTui(port)：Ink render + 备用屏幕进出
   ├─ chat/                      # §13 消息列表
   │  ├─ index.ts
   │  ├─ block.ts                # Block 模型 + 角色→图标/颜色映射（ICON/COLOR 抽出）
   │  ├─ reducer.ts              # AgentToUiMessage → ChatState（纯）★可单测
   │  ├─ viewport.ts             # 行估算 + 滚动窗口裁切（纯）★可单测
   │  └─ browse.ts               # 块浏览焦点 + 折叠展开集合管理（纯）
   ├─ input/                     # §13 输入框（命令逻辑）
   │  ├─ index.ts
   │  └─ commands.ts             # 斜杠命令表：/cmd → 消息 + 意图（纯）★可单测
   ├─ overlays/                  # §13 叠加视图（纯逻辑 + 常量）
   │  ├─ index.ts
   │  ├─ permission/
   │  │  └─ decisions.ts         # 三决策选项 + 标签
   │  └─ config/
   │     ├─ index.ts
   │     ├─ entries.ts           # buildEntries：config + 路径 → 字段列表（纯）
   │     ├─ navigation.ts        # ConfigPath / parentPath 钻取导航（纯）
   │     └─ label.ts             # entryLabel 渲染标签（纯）
   ├─ components/                # 无状态展示组件，一组件一文件夹（view + index）
   │  ├─ top-bar/       ├─ index.tsx └─ view.tsx
   │  ├─ message-block/ ├─ index.tsx └─ view.tsx
   │  ├─ status-bar/    ├─ index.tsx └─ view.tsx
   │  └─ list-picker/   ├─ index.tsx └─ view.tsx
   ├─ theme/
   │  ├─ index.ts  └─ palette.ts # Catppuccin Mocha 调色板（§14）
   └─ markdown/
      ├─ index.ts  └─ render.ts  # markdown → 干净纯文本（§10）
```

474 行的 `index.tsx` 拆成 `app` / `chat` / `input` / `overlays` / `components` / `theme` / `markdown` 七个模块。三个纯函数模块（reducer / viewport / commands）首次可直接单测。

**`App({ port }: { port: UiPort })`**：所有 `agent.send(x)` → `port.post(x)`，`agent.on(cb)` → `port.onMessage(cb)`。**`import type { Agent }` 彻底删除**——本次解耦的落点。`renderTui(port)` 封装 Ink `render()` 并把备用屏幕（alt-screen）进出收进 UI（终端表现层事务归 UI 管）。

**顺带完成（不是纯搬家）**：

- 164 行的 `config-tree.ts` 拆成 entries / navigation / label 三个纯逻辑文件。
- `chat/block.ts` + `chat/browse.ts`：从 474 行组件里抽出角色图标映射、折叠/焦点状态管理，成为可测纯模块。
- `components/` 统一「view.tsx 实现 + index.tsx 导出」，组件长大时同层加文件，导入方路径不变。
- 权限弹层 / 会话·模型选择器 / 标量输入弹层 / 配置树覆盖层的**渲染**统一复用 `ListPicker` 组件承载（原 index.tsx 本就是这样），其菜单项构造逻辑并入 `app.tsx`；只有配置树的纯逻辑（entries/navigation/label）独立成 `overlays/config/`。

## 7. 组合根：根 `main.ts`

```ts
// 薄组合根：全项目唯一同时 import agent 与 ui 的地方
const config = loadConfig()                       // @dogegg/agent
const { agentPort, uiPort } = createChannelPair() // @dogegg/bridge
new Agent({ port: agentPort, config, cwd: process.cwd(), logDir: join(homedir(), '.dogegg', 'logs') })
renderTui(uiPort)                                 // @dogegg/ui
```

约 25 行，替代 `src/main/{index,bootstrap}.ts`。`main.ts` 是根目录的**单个文件**（与 package.json 同级的装配入口，类似 Maven 根 pom 之于 modules），不是第四个模块——组合逻辑必须有归属，放任何一包都会造成反向依赖。

## 8. 工具链（workspace 化的技术要点）

- **typecheck**：`tsc --noEmit -p tsconfig.json && tsc --noEmit -p agent && tsc --noEmit -p ui && tsc --noEmit -p bridge`。各包 `tsconfig.json` `extends ../tsconfig.base.json`；`moduleResolution: "bundler"` 让 `@dogegg/bridge` 经包 `exports` 解析到 `./src/index.ts` 源码（TS 原生支持，无需构建产物）。
- **build**：`build.mjs` 用 esbuild JS API——`bundle / platform=node / format=esm / packages: 'external'` 保持现状，加一个约 10 行插件把 `@dogegg/*` 解析到对应包的 `src/index.ts` 打进产物（npm 依赖保持 external，node 运行时从根 node_modules 取，与现状一致）。`--packages=external` 会把包名 import 全部外置，内部包必须由插件接管——这是 workspaces 化唯一的新机关。
- **test**：根 `vitest.config.ts` 的 include 改为 `['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts']`，vitest 经 workspace 符号链接解析到 TS 源码。`npm test` 一条命令跑全部。
- `npm run dev/start` 语义不变（build → `node dist/index.js`）。
- `.gitignore` 不变；`dist/` 仍从根产出。

## 9. 边界强制：架构测试

`bridge/test/architecture.test.ts` 扫描三个包的源码，断言三层规则：

1. **依赖方向**：
   - `ui/src` 与 `agent/src` 不得 import `@dogegg/agent` / `@dogegg/ui`（互不依赖）；
   - `bridge/src` 不得 import `@dogegg/agent` / `@dogegg/ui`（契约不反向依赖）；
   - 三个包 `src` 之外（组合根除外）不得用相对路径跨包 import（禁止 `../agent/...` 暗道）。
2. **模块边界**：含 `index.ts` 的文件夹必须另有其它源文件（消灭「文件夹里只有一个实现文件」）；跨模块 import 只能指向该模块的 `index.ts`。
3. **体量红线**：`src/` 下任何文件超 250 行即红。

依赖方向从「文档约定」升级为「红了就挂的测试」。放 bridge 是刻意的：桥是边界的所有者，由它守门。

**子域依赖矩阵**（agent / ui 内部，架构测试的额外数据）：

| agent 子域 | 允许依赖（内部） |
|---|---|
| shared / tools / llm / session / permission / config | —（只依赖 bridge） |
| context | llm（compact 要调 adapter 做摘要） |
| loop | context, tools, permission, llm, shared |
| core | 全部 |

| ui 子域 | 允许依赖 |
|---|---|
| theme / markdown / input | — |
| components | theme |
| chat | components, theme, markdown |
| overlays | —（纯逻辑 + 常量，只依赖 bridge） |
| app | 全部 |

## 10. 文件迁移映射

全部源文件 + 测试文件按如下迁移（34 个源文件 + 15 个测试文件）：

| 现文件 | 去向 |
|---|---|
| `src/events/types.ts` | `bridge/src/contract/shared.ts` |
| `src/events/agent-to-ui.ts` / `ui-to-agent.ts` | `bridge/src/contract/` 同名 |
| `src/config/schema.ts` | `bridge/src/contract/config.ts`（schema + 类型） |
| `src/agent/index.ts` | `agent/src/core/agent.ts` + `pending.ts`（ConfigEditor 部分除外） |
| `src/agent/state.ts` | `agent/src/core/state/{events,transition}.ts` |
| `src/agent/loop.ts` | `agent/src/loop/{run,tool-calls,types}.ts`（summarizeHistory → `context/compact/summarize.ts`） |
| `src/agent/context.ts` | `agent/src/context/{prompt/message/token/compact}/` |
| `src/agent/session.ts` | `agent/src/session/{store,list}.ts` |
| `src/agent/permission.ts` | `agent/src/permission/{classify,runtime}.ts` |
| `src/llm/types.ts` | `agent/src/llm/types.ts` |
| `src/llm/provider/openai.ts` | `agent/src/llm/provider/openai/{adapter,request,stream,retry}.ts` |
| `src/llm/streaming/openai.ts` | `agent/src/llm/streaming/openai/{types,parser}.ts` |
| `src/tools/*.ts` | `agent/src/tools/*/{index,schema,execute}.ts`（shell 另加 interpreter/kill-tree） |
| `src/config/loader.ts` | `agent/src/config/loader/{find,load,save}.ts` + `isConfigured` → `resolve/configured.ts` |
| （Agent 内 ~150 行配置编辑） | `agent/src/config/editor/{paths,mutate,validate}.ts`（新 ConfigEditor） |
| `src/common/errors.ts` | `agent/src/shared/errors.ts` |
| `src/common/utils/{id,token-count,truncate,logger,shell}.ts` | 逐文件进 `agent/src/shared/`（token-count→`context/token/estimate.ts`、truncate→`context/message/truncate.ts`、shell→`tools/shell/interpreter.ts`、logger→`shared/logger/`、id→`shared/id.ts`） |
| `src/common/utils/markdown.ts` | `ui/src/tui/markdown/render.ts` |
| `src/ui/tui/index.tsx` | `ui/src/tui/app/app.tsx` + 抽出 `chat/`、`input/`、`overlays/config/`、`overlays/permission/`、`app/view-state.ts` |
| `src/ui/tui/components.tsx` | `ui/src/tui/components/*/{index,view}.tsx` |
| `src/ui/tui/config-tree.ts` | `ui/src/tui/overlays/config/{entries,navigation,label}.ts` |
| `src/main/{index,bootstrap}.ts` | 根 `main.ts` 合并 |
| 15 个 `test/**` | 按上表镜像进各包 `test/` |
| 新增 | `bridge/test/channel.test.ts`、`bridge/test/architecture.test.ts`、`ui/test/tui/chat/{reducer,viewport}.test.ts`、`ui/test/tui/input/commands.test.ts` |
| 删除 | `src/`、`test/` 整目录 |

**文档同步**（CLAUDE.md 规则 2）：原设计 §9「目录结构」整节重写为新结构，§2 的 `events/` 提法改为 `bridge/`；CLAUDE.md 的分层命名与构建说明同步。

## 11. 验证口径（完成的定义）

1. `npm run typecheck` 绿；
2. `npm run test:run` 绿，测试断言数 ≥ 现有 15 个文件的全部断言（另新增 bridge 2 个、ui 3 个）；
3. `npm run build` 产出 `dist/index.js`，`npm start` 可启动 TUI，人工冒烟：发消息、`/config`、权限弹层、折叠展开；
4. `grep -r "from.*agent" ui/src` 无结果——UI 零反向依赖；
5. 架构测试通过（依赖方向 + 模块边界 + 体量红线）。

## 12. 非目标（本次明确不做）

- 不改任何业务逻辑、不新增/删除特性；
- 不做 WebUI（仍仅占位）；
- 不实现 SSE 通道（仅通过 Port 接口预留扩展点，不写 `sse-channel.ts` 实现）；
- 不引入 ESLint / prettier（架构测试覆盖边界，不引新工具链）；
- 不做包的独立发布（workspaces 内部包，不 publish）。