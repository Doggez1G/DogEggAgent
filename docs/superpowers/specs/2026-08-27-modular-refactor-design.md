# DogEggAgent 模块化重构设计

> 状态:已确认,进入实施计划
> 日期:2026-08-27
> 前置文档:`2026-08-26-dog-egg-agent-design.md`(需求与行为契约)。本次重构**不改变其中任何需求能力**,只重构项目结构与模块边界;原文档 §9「目录结构」将在实施时按本设计同步重写。

## 1. 目标与原则

- **需求能力零变化**:13 条需求、状态机语义、消息契约、交互与视觉全部保持现状;本次是纯结构重构 + 边界切口 + 少量重复逻辑收口。
- **三个顶层模块**:`agent`(后端)、`ui`(前端)、`bridge`(桥接层),npm workspaces 真多包形态,各模块独立 `src/` + `test/`。
- **bridge = 契约 + 端口**:全部跨界数据契约与同进程消息通道归 bridge;agent 与 ui 互不知道对方存在,彻底解除现状中 UI 直接 `import type { Agent }` 的实例级耦合。
- **模块 = 文件夹,文件夹内按职责分文件**:禁止单文件大杂烩(见 §9 文件组织规则)。

## 2. 现状问题(本次重构要修掉的六个)

1. **解耦原则没落地**:`ui/tui/index.tsx` 直接 `import type { Agent }`,`App` 组件持有 Agent 实例调 `send()/on()`,前后端实例级耦合,桥接层缺位。
2. **`events/types.ts` 是共享类型大杂烙**:`State`/`Message`/`ToolCall`/`PermissionDecision` 本质都是跨界数据契约,与消息类型混放且归属不清。
3. **`Agent` 类过胖**(351 行):约 150 行配置编辑逻辑(点号路径解析 + 校验回滚 + 重名检查)与编排无关。
4. **`ui/tui/index.tsx` 过胖**(474 行):reducer、视图态、键盘路由、渲染全在一个文件。
5. **`common/` 名不副实**:逐文件核对,`markdown` 只被 UI 用,其余(id/token-count/truncate/logger/shell/errors)全部只被 agent 域用——没有真正的公共代码。
6. **`Config` 类型归属错位**:agent、events 消息、ui 配置树三方引用,却归在 `config/` 域内。

## 3. 顶层结构:npm workspaces 真多包

```
DogEggAgent/
├─ package.json          # workspaces: ["agent","ui","bridge"];根持有 typecheck/test/build 脚本
├─ tsconfig.base.json    # 共享 compilerOptions(strict / ES2022 / bundler 解析等)
├─ tsconfig.json         # 根:extends base,只含 main.ts
├─ vitest.config.ts      # include 三个包的 test/
├─ build.mjs             # esbuild 构建(含 @dogegg/* 解析插件,见 §8)
├─ main.ts               # 组合根:建通道 → 建 Agent → 渲染 TUI
├─ agent/                # @dogegg/agent
├─ ui/                   # @dogegg/ui
└─ bridge/               # @dogegg/bridge
```

依赖方向唯一规则:**agent 与 ui 互相不依赖,都只依赖 bridge;bridge 不依赖任何兄弟模块;只有根 `main.ts` 同时 import agent 与 ui**。由架构测试强制(§10)。

各包均为 `"type": "module"`、`"private": true`,`exports` 直接指向 TS 源码(`"./src/index.ts"`)——**内部包不单独构建**,类型检查、测试、打包都由根一次完成(workspace「内部包」模式:得到真包名 import 与独立包清单的收益,不引入三套构建流水线)。

| 包 | dependencies | 说明 |
|---|---|---|
| `@dogegg/bridge` | `zod` | 契约含 Config 的 zod schema |
| `@dogegg/agent` | `zod`, `@dogegg/bridge` | |
| `@dogegg/ui` | `ink`, `react`, `ink-text-input`, `marked`, `@dogegg/bridge` | |
| 根 `dogegg-agent` | `@dogegg/agent`, `@dogegg/ui`, `@dogegg/bridge` + 全部 devDeps | main.ts 的依赖 |

## 4. bridge:契约 + 通道

```
bridge/
├─ package.json / tsconfig.json
├─ src/
│  ├─ index.ts              # 全部公共导出
│  ├─ contract/
│  │  ├─ index.ts
│  │  ├─ shared.ts          # State / PermissionDecision / ToolCall / Message(← src/events/types.ts)
│  │  ├─ config.ts          # Config 的 zod schema + 类型(← src/config/schema.ts)
│  │  ├─ agent-to-ui.ts     # AgentToUiMessage(← src/events/agent-to-ui.ts)
│  │  └─ ui-to-agent.ts     # UiToAgentMessage(← src/events/ui-to-agent.ts)
│  └─ channel/
│     ├─ index.ts
│     ├─ port.ts            # AgentPort / UiPort 接口
│     └─ in-memory.ts       # createChannelPair():同进程通道
└─ test/
   ├─ channel.test.ts       # 投递 / 退订 / 双向
   └─ architecture.test.ts  # 模块边界警察(§10)
```

**契约归 bridge 的原则**:凡是「要跨 agent/ui 边界的数据形状」都归 bridge 所有权——不止两套消息 union,连 `State`/`Message`/`Config` 也一起搬入(它们本来就是事实上的跨界契约,消息字段引用它们)。Config 的 **zod schema 本体**(不只是类型)放 bridge:单一事实源,agent 做加载与编辑,ui 做类型消费,永不漂移。

**Port API**(本次唯一的新抽象,~60 行):

```ts
export interface AgentPort {
  onMessage(cb: (msg: UiToAgentMessage) => void): () => void
  post(msg: AgentToUiMessage): void
}
export interface UiPort {
  onMessage(cb: (msg: AgentToUiMessage) => void): () => void
  post(msg: UiToAgentMessage): void
}
```

- `createChannelPair()` 返回 `{ agentPort, uiPort }`,同进程内同步投递——与今天 `agent.send()`/`emit` 的时序语义完全一致,保证行为不变。
- 将来 WebUI:bridge 里加 `channel/sse.ts`(SSE 下行 + POST 上行)实现同样的 Port 接口;agent 与 ui 一行不改——原设计文档 §2「传输无关、复用同一套消息类型」承诺的实体化。
- `post()` 发后即忘(同步、无返回值):模拟真实消息边界,UI 从此不能 await agent 的任何方法(现在也没 await 过,无行为损失)。

## 5. agent:后端域(文件级)

### 5.1 结构

```
agent/
├─ package.json / tsconfig.json
├─ src/
│  ├─ index.ts                      # 包出口:Agent / loadConfig(纯导出)
│  ├─ core/                         # agent 核心
│  │  ├─ index.ts
│  │  ├─ agent.ts                   # Agent 类:构造装配、port 订阅、emit+日志埋点
│  │  ├─ commands.ts                # 命令分发:UiToAgentMessage → 处理器
│  │  ├─ turn.ts                    # 轮次生命周期:running/cancelled/AbortController/runLoop 调用/落盘
│  │  ├─ pending.ts                 # 挂起权限表:request/resolve/reject(Map 管理)
│  │  └─ state/
│  │     ├─ index.ts
│  │     ├─ events.ts               # TransitionInput 迁移输入类型
│  │     └─ transition.ts           # 9 态纯函数迁移表
│  ├─ loop/                         # 需求#1:问模型 → 串行工具 → 回填 → 再问
│  │  ├─ index.ts
│  │  ├─ types.ts                   # LoopDeps
│  │  ├─ run.ts                     # 主循环:迭代上限/取消检查/压缩触发/请求模型
│  │  └─ tool-calls.ts              # 串行工具执行:参数解析校验/权限分支/逐个回填/最后重问
│  ├─ context/                      # 需求#3:上下文组装门面(index.ts 汇总对外 API)
│  │  ├─ index.ts
│  │  ├─ prompt/                    # 需求#5:system prompt
│  │  │  ├─ index.ts  ├─ load.ts    #   读配置路径的 system prompt
│  │  │  └─ builtin.ts              #   内置默认 prompt
│  │  ├─ message/                   # 需求#6:历史消息进入上下文前的整形
│  │  │  ├─ index.ts  ├─ truncate.ts     #   工具结果截断(cap 8000,截断处注明)
│  │  │  └─ tool-result.ts          #   ToolResult → 历史消息 content 的整形(从 loop 内联抽出)
│  │  ├─ token/                     # 需求#7:token 估算 + 窗口预算
│  │  │  ├─ index.ts  ├─ estimate.ts      #   字符→token 粗估(CJK 规则)
│  │  │  └─ budget.ts               #   system+历史+工具 schema 的总占用
│  │  └─ compact/                   # 需求#12:压缩(自动+手动统一入口)
│  │     ├─ index.ts  ├─ trigger.ts       #   80% 阈值判断
│  │     ├─ split.ts                #   保留最近 4 条的切分
│  │     ├─ summarize.ts            #   调 LLM 压摘要
│  │     └─ compact.ts              #   compactHistory 编排(loop 与 /compact 共用)
│  ├─ llm/                          # LLM 接入
│  │  ├─ index.ts  ├─ types.ts      # LlmStreamEvent / ChatRequest / ProviderAdapter(后端内部,不进 bridge)
│  │  ├─ provider/openai/
│  │  │  ├─ index.ts  ├─ adapter.ts       #   openAiAdapter 组装
│  │  │  ├─ request.ts              #   ChatRequest → HTTP body
│  │  │  ├─ stream.ts               #   fetch + SSE 流读取循环(逐行喂 parser)
│  │  │  └─ retry.ts                #   重试策略(AbortError 不重试)
│  │  └─ streaming/openai/
│  │     ├─ index.ts  ├─ types.ts         #   SSE chunk 类型窄化形状
│  │     └─ parser.ts               #   行驱动解析器(分片拼接/reasoning→thought_delta)
│  ├─ tools/                        # 需求#2
│  │  ├─ index.ts                   # registry:getAllTools/getTool/toolSchemas
│  │  ├─ types.ts                   # Tool / ToolContext / ToolResult 契约
│  │  ├─ read_file/                 # index.ts + schema.ts(定义) + execute.ts(实现)
│  │  ├─ write_file/                # 同上三件套
│  │  ├─ edit_file/                 # 同上三件套
│  │  └─ shell/
│  │     ├─ index.ts  ├─ schema.ts  ├─ execute.ts
│  │     ├─ interpreter.ts          #   shellProgram → {program, flag}(← common/utils/shell)
│  │     └─ kill-tree.ts            #   进程树终止(win taskkill / POSIX 进程组)
│  ├─ session/                      # 需求#11
│  │  ├─ index.ts  ├─ store.ts      #   save/load(JSON 持久化)
│  │  └─ list.ts                    #   会话列表 + preview
│  ├─ permission/                   # 需求#10
│  │  ├─ index.ts  ├─ classify.ts   #   三桶静态分类
│  │  └─ runtime.ts                 #   运行时 allow_always 会话内提升
│  ├─ config/                       # 配置域(schema 本体在 bridge 契约里)
│  │  ├─ index.ts
│  │  ├─ loader/
│  │  │  ├─ index.ts  ├─ find.ts    #   配置文件定位(.dogegg.json 优先)
│  │  │  ├─ load.ts                 #   loadConfig + 默认值填充
│  │  │  └─ save.ts                 #   saveConfig 落盘
│  │  ├─ editor/                    # 从 Agent 抽出的 ~150 行配置编辑服务
│  │  │  ├─ index.ts                #   ConfigEditor 门面
│  │  │  ├─ paths.ts                #   点号路径文法解析(providers.<i>.models.<j>.field)
│  │  │  ├─ mutate.ts               #   set/add/remove 对 config 对象的实际变更
│  │  │  └─ validate.ts             #   重校验 + 重名检查 + 回滚快照
│  │  └─ resolve/
│  │     ├─ index.ts  ├─ current.ts       #   当前 provider+model 解析(收编 ProviderRegistry)
│  │     └─ configured.ts           #   isConfigured 完整性判定
│  └─ shared/                       # 跨子域支撑
│     ├─ index.ts  ├─ errors.ts     #   CancelledError
│     ├─ id.ts                      #   短 id
│     └─ logger/
│        ├─ index.ts  ├─ init.ts    #   日志目录初始化
│        ├─ write.ts                #   追加写
│        └─ tail.ts                 #   /log 尾部读取
└─ test/                            # 镜像 src 结构(§11 映射表)
```

### 5.2 需求 → 模块映射(拆分骨架,每条需求唯一归宿)

| 需求 | 归宿 |
|---|---|
| #1 Agent Loop | `loop/` |
| #2 Tool Calling | `tools/`(执行由 loop 串行驱动) |
| #3 Context 组装 | `context/`(门面) |
| #4 Message History | `core` 持有 + `session/` 持久化;**故意不放 context**,保住「历史与上下文分离」 |
| #5 System Prompt | `context/prompt/` |
| #6 Tool Result 截断 | `context/message/` |
| #7 Context Window | `context/token/` |
| #8 Agent State | `core/state/` |
| #9 Event System | `bridge`(契约 + 通道) |
| #10 Permission | `permission/` |
| #11 Session | `session/` |
| #12 Compaction | `context/compact/` |
| 配置 | `config/` + bridge 契约 |

### 5.3 结构修正(不只是搬家)

- **压缩逻辑统一**:现状 loop 内联做自动压缩、`Agent.compactNow` 重写一遍手动压缩,两处重复。统一为 `context/compact/compact.ts` 的 `compactHistory()`,loop 与 `/compact` 都调它;摘要逻辑只在 `context/compact/summarize.ts` 一处(loop 不再有私有 summarize)。
- **provider/model 解析统一**:现状 `ProviderRegistry`、`isConfigured`、`Agent.currentProvider/currentModel` 三处各写一遍「从 config 找当前 provider+model」。统一为 `config/resolve`,`ProviderRegistry` 类消解。
- **Agent 瘦身**:351 行 → 约 200 行纯门面。构造函数变为 `new Agent({ port, config, cwd, logDir })`,内部自订阅 port 消息;`on()/send()` 公共方法删除——agent 从此只有消息这一个进出通道。`emit()` 改为 `port.post()`(日志埋点原样保留)。配置编辑 150 行进 `config/editor`。
- **原 209 行 `loop.ts` 拆三块**:run(主循环)/ tool-calls(串行执行)/ 摘要归 context;原 `Agent` 拆 agent / commands / turn / pending 四块。
- **工具统一「schema 定义与 execute 实现分文件」模式**;shell 另带 interpreter 与 kill-tree 两个机制文件。
- **`common/` 不复存在**:`errors/id/token-count/truncate/logger/shell` 全部只有 agent 一个消费域,搬进 `agent/src/shared/` 与各归宿模块;`markdown` 只有 UI 用,搬进 `ui/src/tui/markdown/`。

## 6. ui:前端域(文件级)

```
ui/
├─ package.json / tsconfig.json     # 仅此包开 jsx: react-jsx
├─ src/
│  ├─ index.ts                      # 包出口:renderTui(纯导出)
│  └─ tui/
│     ├─ index.ts
│     ├─ app/                       # 应用装配层
│     │  ├─ index.ts
│     │  ├─ app.tsx                 # App 组件:状态持有 + 渲染骨架(装配,不含逻辑)
│     │  ├─ view-state.ts           # View 视图态联合(叠加在 chat 之上的弹层状态机,纯)
│     │  ├─ keys.ts                 # 键盘路由:按键 → 当前视图/输入框/块浏览 的分发
│     │  └─ entry.ts                # renderTui(port):Ink render + 备用屏幕进出
│     ├─ chat/                      # §13 消息列表
│     │  ├─ index.ts
│     │  ├─ block.ts                # Block 模型 + 角色→图标/颜色映射
│     │  ├─ reducer.ts              # AgentToUiMessage → ChatState(纯)★新可单测
│     │  ├─ viewport.ts             # 行估算 + 滚动窗口裁切(纯)★新可单测
│     │  └─ browse.ts               # 块浏览焦点 + 折叠展开集合的管理(纯)★新可单测
│     ├─ input/                     # §13 输入框
│     │  ├─ index.ts
│     │  ├─ commands.ts             # 斜杠命令表:/cmd → UiToAgentMessage(纯)★新可单测
│     │  └─ input-box.tsx           # 输入框组件 + 提交流程
│     ├─ overlays/                  # §13 叠加视图
│     │  ├─ index.ts
│     │  ├─ permission/
│     │  │  ├─ index.ts  ├─ decisions.ts    #   三决策选项 + 标签
│     │  │  └─ overlay.tsx           #   权限弹层视图
│     │  ├─ pickers/
│     │  │  ├─ index.ts  ├─ menu.ts          #   通用菜单机制(MenuItem/光标移动)
│     │  │  ├─ session-picker.tsx    #   会话选择器
│     │  │  └─ model-picker.tsx      #   模型两级选择器
│     │  ├─ prompt/
│     │  │  ├─ index.ts  └─ overlay.tsx      #   标量输入弹层(配置编辑用)
│     │  └─ config/                 # 配置编辑器
│     │     ├─ index.ts
│     │     ├─ entries.ts           #   buildEntries:config+路径 → 字段列表(纯)
│     │     ├─ navigation.ts        #   ConfigPath / parentPath 钻取导航(纯)
│     │     ├─ label.ts             #   entryLabel 渲染标签(纯)
│     │     └─ editor.tsx           #   配置编辑器视图
│     ├─ components/                # 无状态展示组件,一组件一文件夹(view + index)
│     │  ├─ top-bar/       ├─ index.tsx └─ view.tsx
│     │  ├─ message-block/ ├─ index.tsx └─ view.tsx
│     │  ├─ status-bar/    ├─ index.tsx └─ view.tsx
│     │  └─ list-picker/   ├─ index.tsx └─ view.tsx
│     ├─ theme/
│     │  ├─ index.ts  └─ palette.ts  # Catppuccin Mocha 调色板(§14)
│     └─ markdown/
│        ├─ index.ts  └─ render.ts   # markdown → 干净纯文本
└─ test/                            # 镜像 src
```

- `App({ port }: { port: UiPort })`:所有 `agent.send(x)` → `port.post(x)`,`agent.on(cb)` → `port.onMessage(cb)`,**`import type { Agent }` 彻底删除**——解耦的落点。
- `renderTui(port)` 封装 Ink `render()` 并收编备用屏幕(alt-screen)进出(终端表现层事务,归 UI 管)。
- 原 474 行 `index.tsx` 拆成 8 个模块;原 164 行 `config-tree.ts` 拆成 entries / navigation / label 三个纯逻辑文件;角色图标映射、折叠/焦点状态管理从组件里抽出成为可测纯模块(`chat/block.ts`、`chat/browse.ts`)。

## 7. 组合根:根 `main.ts`

```ts
// 薄组合根:全项目唯一同时 import agent 与 ui 的地方(~25 行)
const config = loadConfig()                        // @dogegg/agent
const { agentPort, uiPort } = createChannelPair()  // @dogegg/bridge
new Agent({ port: agentPort, config, cwd: process.cwd(), logDir })  // logDir = ~/.dogegg/logs
renderTui(uiPort)                                  // @dogegg/ui
```

替代现在的 `src/main/{index,bootstrap}.ts`。`main.ts` 是根目录的单个装配入口文件(与 package.json 同级),不是第四个模块——组合逻辑必须有归属,放任何一包里都会造成反向依赖。

## 8. 工具链

- **typecheck**:`tsc --noEmit` 依次跑根、agent、ui、bridge 四个 tsconfig。各包 tsconfig `extends ../tsconfig.base.json`;`moduleResolution: "bundler"` 让 `@dogegg/*` 经包 `exports` 解析到 `./src/index.ts` 源码(TS 原生支持,无需构建产物、无需 project references)。
- **build**:`build.mjs` 用 esbuild JS API,保持 `bundle / platform=node / format=esm`。不用 `--packages=external`(它会把 `@dogegg/*` 也外置),改用插件接管裸导入:filter 匹配所有裸说明符,`@dogegg/*` 解析到对应包 `src/index.ts` 打进产物,其余(react/ink/zod/marked/ink-text-input/node 内置)返回 `external: true`——运行时从根 node_modules 取,与今天一致。产物仍为 `dist/index.js`。
- **test**:根 `vitest.config.ts` 的 include 改为 `['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts']`;vitest 经 workspace 符号链接解析 `@dogegg/*` 到 TS 源码(链接包默认按源码处理)。若解析有问题,fallback 在 vitest.config 用 `resolve.alias` 直映射 `@dogegg/*` → 各包 src。
- `npm run dev/start` 语义不变(build → `node dist/index.js`);`dist/` 仍从根产出,`.gitignore` 不变。

## 9. 文件组织规则(全项目硬规则)

1. **每个模块文件夹必须有 `index.ts`**,index 只做导出汇总(**≤30 行,不写任何逻辑**);实现全部放在职责文件里,跨模块 import 只能指向模块入口(`import ... from '../context'` 而非 `'../context/compact/split'`)。
2. **文件夹内按职责拆文件**:一个文件只承载一个职责;禁止「一个 ts 文件写全部功能」。
3. **体量红线**:源文件 ≤ 250 行(测试文件不受限),超出必须拆。
4. 注释与命名遵循 CLAUDE.md 代码规范:详细注释说明非显然的「为什么」(状态机迁移、流式 tool_calls 参数拼接、进程树 kill、上下文裁剪等)。

## 10. 边界强制:架构测试

`bridge/test/architecture.test.ts` 扫描三个包的源码,以下任一违规即测试红:

1. **包级依赖方向**:agent/src 与 ui/src 不得出现 `@dogegg/agent` / `@dogegg/ui` 的 import(互不依赖);bridge/src 不得出现任何 `@dogegg/*` 兄弟包 import(契约不反向依赖)。
2. **禁止暗道**:三个包的 src 内不得用相对路径跨包 import(如 `../../agent/...`)。
3. **子域依赖矩阵**(agent/ui 内部,只允许向下依赖):

   | agent 子域 | 允许的内部依赖 |
   |---|---|
   | shared / tools / llm / session / permission / config | —(只依赖 bridge) |
   | context | llm(compact 摘要要调 adapter) |
   | loop | context, tools, permission, llm, shared |
   | core | 全部 |

   | ui 子域 | 允许的内部依赖 |
   |---|---|
   | theme / markdown / input | — |
   | components | theme |
   | chat | components, theme, markdown |
   | overlays | components, theme |
   | app | 全部 |

4. **文件组织**:含 `index.ts` 的文件夹必须还有其它源文件或子文件夹(消灭「文件夹里只有一个实现文件」);src 下源文件 ≤ 250 行;`index.ts` ≤ 30 行。

放 bridge 是刻意的:桥是边界的所有者,由它守门。依赖方向从「写在文档里的约定」升级为「红了就挂的测试」。

## 11. 文件迁移映射

| 现文件 | 去向 |
|---|---|
| `src/events/types.ts` | `bridge/src/contract/shared.ts` |
| `src/events/agent-to-ui.ts` / `ui-to-agent.ts` | `bridge/src/contract/` 同名 |
| `src/config/schema.ts` | `bridge/src/contract/config.ts`(schema + 类型) |
| `src/agent/index.ts` | `agent/src/core/agent.ts` + `commands.ts` + `turn.ts` + `pending.ts`(配置编辑部分 → `config/editor/`) |
| `src/agent/state.ts` | `agent/src/core/state/`(events.ts + transition.ts) |
| `src/agent/loop.ts` | `agent/src/loop/`(types/run/tool-calls;summarize → `context/compact/summarize.ts`) |
| `src/agent/context.ts` | `agent/src/context/`(prompt/message/token/compact 四个子模块) |
| `src/agent/session.ts` | `agent/src/session/`(store + list) |
| `src/agent/permission.ts` | `agent/src/permission/`(classify + runtime) |
| `src/llm/**` | `agent/src/llm/**`(provider/openai 拆 adapter/request/stream/retry) |
| `src/tools/**` | `agent/src/tools/**`(每工具 schema/execute 分文件;shell 另带 interpreter/kill-tree) |
| `src/config/loader.ts` | `agent/src/config/loader/`(find/load/save)+ `resolve/`(收编 isConfigured 与 ProviderRegistry) |
| (Agent 内 ~150 行配置编辑) | `agent/src/config/editor/`(paths/mutate/validate) |
| `src/common/errors.ts` + `utils/{id,token-count,truncate,logger,shell}.ts` | `agent/src/shared/`(errors/id/logger);token-count → `context/token/estimate.ts`;truncate → `context/message/truncate.ts`;shell → `tools/shell/interpreter.ts` |
| `src/common/utils/markdown.ts` | `ui/src/tui/markdown/render.ts` |
| `src/ui/tui/index.tsx` | `ui/src/tui/app/` + `chat/` + `input/` + `overlays/` 按职责拆散 |
| `src/ui/tui/components.tsx` | `ui/src/tui/components/` 一组件一文件夹 |
| `src/ui/tui/config-tree.ts` | `ui/src/tui/overlays/config/`(entries/navigation/label) |
| `src/main/{index,bootstrap}.ts` | 根 `main.ts` 合并 |
| 15 个 `test/**` | 按上表镜像进各包 `test/`(详见 §12) |
| 新增 | `bridge/test/channel.test.ts`、`bridge/test/architecture.test.ts` |
| 删除 | `src/`、`test/` 整目录 |

**同步文档**(CLAUDE.md 规则 2):实施完成时,原设计文档 §9「目录结构」整节重写为新结构(注明 v1.1 结构决策:workspace、Port、契约归属);CLAUDE.md 的分层命名与构建说明同步更新。

## 12. 测试落位(15 个现有 + 新增)

**agent/test/**(镜像 src):
`core/agent.test.ts`(改为经 channel 黑盒驱动)、`core/state/transition.test.ts`、`loop/run.test.ts`(原 loop.test.ts)、`context/prompt/load.test.ts`、`context/token/budget.test.ts`(含 estimate)、`context/message/truncate.test.ts`、`context/compact/compact.test.ts`(split/trigger)、`llm/provider/openai/adapter.test.ts`(重试)、`llm/streaming/openai/parser.test.ts`、`tools/file-tools.test.ts`(read/write/edit)、`tools/shell/interpreter.test.ts`、`session/store.test.ts`、`permission/classify.test.ts`、`config/loader/load.test.ts`、`config/editor/editor.test.ts`(路径解析/回滚,新)、`config/resolve/resolve.test.ts`(新)、`shared/logger/logger.test.ts`

**ui/test/**:
`tui/chat/reducer.test.ts`(新)、`tui/chat/viewport.test.ts`(新)、`tui/chat/browse.test.ts`(新)、`tui/input/commands.test.ts`(新)、`tui/overlays/config/entries.test.ts`(原 config-tree.test.ts)、`tui/markdown/render.test.ts`(原 markdown.test.ts)

**bridge/test/**:
`channel.test.ts`(新)、`architecture.test.ts`(新)

现有测试断言全部保留;仅 import 路径与 `agent.test.ts` 的驱动方式(实例直调 → 经 channel 消息)调整。

## 13. 验证口径(完成的定义)

1. `npm run typecheck` 绿;
2. `npm run test:run` 绿,覆盖原 15 个测试文件的全部断言 + bridge 新增 2 个;
3. `npm run build` 产出 `dist/index.js`,`npm start` 可启动 TUI,人工冒烟:发消息、`/config`、权限弹层、折叠展开;
4. `ui/src` 内 grep 不到任何对 agent 的 import——UI 零反向依赖;
5. 架构测试(§10 全部四类检查)通过;
6. 原设计文档 §9 与 CLAUDE.md 已同步新结构。

## 14. 非目标

- 不改任何需求行为、消息契约语义、交互与视觉;
- 不实现 WebUI/SSE 通道(只保证 Port 接口使将来可加);
- 不引入包级独立构建流水线(内部包不单独 build);
- 不做无关的顺手重构(只收口 §5.3 列出的四处重复)。
