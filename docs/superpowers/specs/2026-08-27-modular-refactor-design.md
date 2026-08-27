# DogEggAgent 模块化重构设计

> 状态:已确认,待进入实现计划
> 日期:2026-08-27
> 前置:基于 `2026-08-26-dog-egg-agent-design.md`(需求与行为单一事实源,本文不重复其内容)

## 1. 目标与原则

把现有单 `src/` 平铺结构重构为**三个顶层模块包**,类似 Java 微服务的模块化形态:

- **行为零变化**:设计文档 2026-08-26 的 13 条需求能力不变,一切交互、快捷键、视觉不变。本次是纯结构重构 + 边界切口。
- **解耦真正落地**:现状 `ui/tui/index.tsx` 直接 `import type { Agent }`,前后端是实例级耦合,违反原设计「后端不 import 前端、前端不 import 后端」的硬约束。本次以 Port 通道彻底切断。
- **模块=文件夹**:任何模块都是文件夹,`index.ts` 是唯一对外脸面。
- **一职责一文件**:文件夹内按职责拆文件,禁止单文件大杂烩(AI 生成代码的常见病灶)。

顺带修掉的现状结构问题(共 6 个):

1. UI→Agent 实例耦合(`import type { Agent }` + `agent.send()/on()`);
2. `events/types.ts` 混装 `State`/`Message`/`ToolCall`/`PermissionDecision`,契约归属错位;
3. `Agent` 类过胖(351 行,其中约 150 行是配置编辑);
4. `ui/tui/index.tsx` 过胖(474 行,reducer/视图态/键盘/渲染混装);
5. `common/` 名不副实——逐文件核对后,`markdown` 只有 UI 用,其余全部只有 agent 域用,不存在真公共代码;
6. `Config` 类型是事实上的跨界契约(agent/events/ui 三方引用)却归在 `config/`。

## 2. 顶层形态:npm workspaces 真多包

```
DogEggAgent/
├─ package.json          # workspaces: ["agent","ui","bridge"];根持有 typecheck/test/build 脚本
├─ tsconfig.base.json    # 共享 compilerOptions(strict / moduleResolution: bundler 等)
├─ tsconfig.json         # 根:extends base,只含 main.ts
├─ vitest.config.ts      # include 三个包的 test/
├─ build.mjs             # esbuild 构建(含 @dogegg/* 解析插件,见 §9)
├─ main.ts               # 组合根:建通道 → 建 Agent → 渲染 TUI
├─ agent/                # @dogegg/agent
├─ ui/                   # @dogegg/ui
└─ bridge/               # @dogegg/bridge
```

各包 `package.json` 均 `"type": "module"`,`exports` 直接指向 TS 源码(`./src/index.ts`)——**包不单独构建**,类型检查、测试、打包由根一次完成(workspace「内部包」模式):得到真包名 import 与独立包清单的收益,不引入三套构建流水线。

依赖声明(依赖表本身即文档):

| 包 | dependencies | 说明 |
|---|---|---|
| `@dogegg/bridge` | `zod` | 契约含 Config 的 zod schema |
| `@dogegg/agent` | `zod`, `@dogegg/bridge` | |
| `@dogegg/ui` | `ink`, `react`, `ink-text-input`, `marked`, `@dogegg/bridge` | |
| 根 `dogegg-agent` | `@dogegg/agent`, `@dogegg/ui`, `@dogegg/bridge` + 全部 devDeps | main.ts 的依赖 |

## 3. 依赖方向(唯一硬规则)

```
                ┌─────────┐
                │ main.ts │  组合根(根目录单文件,~25 行)
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

- `agent` 与 `ui` 互相不知道对方存在,都只依赖 `bridge`;
- `bridge` 不依赖任何兄弟模块;
- 只有 `main.ts` 同时 import agent 和 ui;
- 由 `bridge/test/architecture.test.ts` 强制(见 §10),违规即测试红。

组合根必须是根目录的单个 `main.ts`(与 package.json 同级的装配入口,类似 Maven 根 pom 之于 modules),不是第四个模块:组合逻辑放任何一包里都会造成反向依赖。

## 4. bridge:契约 + 通道

```
bridge/
├─ package.json / tsconfig.json
├─ src/
│  ├─ index.ts              # 全部公共导出(纯导出)
│  ├─ contract/
│  │  ├─ index.ts           # 契约域导出汇总
│  │  ├─ shared.ts          # State / PermissionDecision / ToolCall / Message(← events/types.ts)
│  │  ├─ config.ts          # Config 的 zod schema + 类型(← config/schema.ts)
│  │  ├─ agent-to-ui.ts     # AgentToUiMessage(← events/agent-to-ui.ts)
│  │  └─ ui-to-agent.ts     # UiToAgentMessage(← events/ui-to-agent.ts)
│  └─ channel/
│     ├─ index.ts           # 通道域导出汇总
│     ├─ port.ts            # AgentPort / UiPort 接口
│     └─ in-memory.ts       # createChannelPair():同进程通道
└─ test/
   ├─ channel.test.ts       # 投递 / 退订 / 双向
   └─ architecture.test.ts  # 边界警察(包级规则 + 子域矩阵 + 文件组织规则)
```

**契约归 bridge 的原则**:凡是「要跨 agent/ui 边界的数据形状」都归 bridge 所有权——不止两套消息 union,连 `State`/`Message`/`Config`/`PermissionDecision` 一起搬入(它们本就是事实上的跨界契约,消息字段引用它们)。Config 的 **zod schema 本体**(不只是类型)放 bridge:单一事实源,agent 做加载与编辑,ui 做类型消费,永不漂移。

**Port API**(本次唯一的新抽象):

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

- `createChannelPair()` 返回 `{ agentPort, uiPort }`,同进程内同步投递(与今天 `agent.send()`/`emit` 的时序语义一致,保证行为不变);
- `post()` 发后即忘(同步、无返回值):模拟真实消息边界;
- 将来 WebUI:bridge 里加 `sse-channel.ts` 实现同一 Port 接口,agent 与 ui 一行不改——原设计「消息契约传输无关、复用同一套消息类型」承诺的实体化。

## 5. agent:后端域(按需求逐条归位)

```
agent/
├─ package.json / tsconfig.json
├─ src/
│  ├─ index.ts                      # 包出口:Agent / loadConfig(纯导出)
│  ├─ state/                        # 需求#8:9 态状态机。纯函数、零内部依赖,置顶层:
│  │  ├─ index.ts                   #   loop(驱动迁移)与 core(复位/追踪)都依赖它,
│  │  ├─ events.ts                  #   放 core/ 下会造成 loop→core 的反向依赖
│  │  └─ transition.ts              #   TransitionInput 类型 / 迁移表
│  ├─ core/                         # agent 核心
│  │  ├─ index.ts
│  │  ├─ agent.ts                   # Agent 类:构造装配、port 订阅、emit+日志埋点
│  │  ├─ commands.ts                # 命令分发:UiToAgentMessage → 处理器
│  │  ├─ turn.ts                    # 轮次生命周期:running/cancelled/AbortController/runLoop 调用/落盘
│  │  └─ pending.ts                 # 挂起权限表:request/resolve/reject(Map 管理)
│  ├─ loop/                         # 需求#1:问模型 → 串行工具 → 回填 → 再问
│  │  ├─ index.ts
│  │  ├─ types.ts                   # LoopDeps
│  │  ├─ run.ts                     # 主循环:迭代/maxIterations/取消检查/压缩触发
│  │  └─ tool-calls.ts              # 串行工具执行:参数校验/权限分支/逐个回填/最后重问
│  ├─ context/                      # 需求#3:上下文组装(index.ts 为门面)
│  │  ├─ index.ts
│  │  ├─ prompt/                    # 需求#5
│  │  │  ├─ index.ts
│  │  │  ├─ load.ts                 #   读配置路径的 system prompt
│  │  │  └─ builtin.ts              #   内置默认 prompt
│  │  ├─ message/                   # 需求#6:历史消息进入上下文前的整形
│  │  │  ├─ index.ts
│  │  │  ├─ truncate.ts             #   工具结果截断(cap 8000)
│  │  │  └─ tool-result.ts          #   ToolResult → content 的整形(从 loop 内联抽出)
│  │  ├─ token/                     # 需求#7
│  │  │  ├─ index.ts
│  │  │  ├─ estimate.ts             #   字符→token 粗估(CJK 规则)
│  │  │  └─ budget.ts               #   system+历史+工具 schema 总占用
│  │  └─ compact/                   # 需求#12
│  │     ├─ index.ts
│  │     ├─ trigger.ts              #   80% 阈值判断
│  │     ├─ split.ts                #   保留最近 4 条的切分
│  │     ├─ summarize.ts            #   调 LLM 压摘要
│  │     └─ compact.ts              #   compactHistory 编排(自动+手动统一入口)
│  ├─ llm/                          # LLM 接入
│  │  ├─ index.ts
│  │  ├─ types.ts                   # LlmStreamEvent / ChatRequest / ProviderAdapter
│  │  ├─ provider/openai/
│  │  │  ├─ index.ts
│  │  │  ├─ adapter.ts              #   openAiAdapter 组装
│  │  │  ├─ request.ts              #   ChatRequest → HTTP body
│  │  │  ├─ stream.ts               #   fetch + SSE 流读取循环
│  │  │  └─ retry.ts                #   重试策略(AbortError 不重试)
│  │  └─ streaming/openai/
│  │     ├─ index.ts
│  │     ├─ types.ts                #   SSE chunk 类型窄化形状
│  │     └─ parser.ts               #   行驱动解析器(分片拼接/reasoning→thought_delta)
│  ├─ tools/                        # 需求#2
│  │  ├─ index.ts                   # registry:getAllTools/getTool/toolSchemas
│  │  ├─ types.ts                   # Tool / ToolContext / ToolResult 契约
│  │  ├─ read_file/                 #   ├─ index.ts ├─ schema.ts(定义) └─ execute.ts(实现)
│  │  ├─ write_file/                #   同上模式
│  │  ├─ edit_file/                 #   同上模式
│  │  └─ shell/
│  │     ├─ index.ts  ├─ schema.ts  ├─ execute.ts
│  │     ├─ interpreter.ts          #   shellProgram → {program, flag}
│  │     └─ kill-tree.ts            #   进程树终止(win taskkill / POSIX 进程组)
│  ├─ session/                      # 需求#11
│  │  ├─ index.ts
│  │  ├─ store.ts                   #   save/load(JSON 持久化)
│  │  └─ list.ts                    #   会话列表 + preview
│  ├─ permission/                   # 需求#10
│  │  ├─ index.ts
│  │  ├─ classify.ts                #   三桶静态分类
│  │  └─ runtime.ts                 #   运行时 allow_always 会话内提升
│  ├─ config/                       # 配置域(schema 本体在 bridge 契约里)
│  │  ├─ index.ts
│  │  ├─ loader/
│  │  │  ├─ index.ts
│  │  │  ├─ find.ts                 #   配置文件定位(.dogegg.json 优先)
│  │  │  ├─ load.ts                 #   loadConfig + 默认值填充
│  │  │  └─ save.ts                 #   saveConfig 落盘
│  │  ├─ editor/                    #   (从 Agent 抽出的 ~150 行)
│  │  │  ├─ index.ts                #   ConfigEditor 门面
│  │  │  ├─ paths.ts                #   点号路径文法解析(providers.<i>.models.<j>.field)
│  │  │  ├─ mutate.ts               #   set/add/remove 对 config 对象的实际变更
│  │  │  └─ validate.ts             #   重校验 + 重名检查 + 回滚快照
│  │  └─ resolve/
│  │     ├─ index.ts
│  │     ├─ current.ts              #   当前 provider+model 解析(收编 ProviderRegistry)
│  │     └─ configured.ts           #   isConfigured 完整性判定
│  └─ shared/                       # 跨子域支撑(← src/common 中 agent 域部分)
│     ├─ index.ts
│     ├─ errors.ts                  #   CancelledError
│     ├─ id.ts                      #   短 id
│     └─ logger/
│        ├─ index.ts
│        ├─ init.ts                 #   日志目录初始化
│        ├─ write.ts                #   追加写
│        └─ tail.ts                 #   /log 尾部读取
└─ test/                            # 镜像 src(见 §11)
```

**需求 → 模块映射**(拆分骨架,每条需求唯一归宿):

| 需求(2026-08-26 文档 §3) | 归宿 |
|---|---|
| #1 Agent Loop | `loop/` |
| #2 Tool Calling | `tools/`(执行由 loop 串行驱动) |
| #3 Context 组装 | `context/`(门面) |
| #4 Message History | `core` 持有 + `session/` 持久化;**故意不放 context**,保住「历史与上下文分离」 |
| #5 System Prompt | `context/prompt/` |
| #6 Tool Result 截断 | `context/message/` |
| #7 Context Window | `context/token/` |
| #8 Agent State | `state/`(顶层,纯函数;loop 与 core 都依赖它,放 core 下会造成反向依赖) |
| #9 Event System | `bridge/`(契约 + 通道) |
| #10 Permission | `permission/` |
| #11 Session | `session/` |
| #12 Compaction | `context/compact/` |
| #13 UI | `ui/`(见 §6) |

**Agent 瘦身**(351 行 → ~200 行纯门面):构造函数变为 `new Agent({ port, config, cwd, logDir })`,内部自订阅 port 消息;`on()/send()` 公共方法删除——agent 从此只有消息这一个进出通道;`emit()` 内部改为 `port.post()`(日志埋点逻辑原样保留)。

**拆分顺带统一的重复逻辑**(不是纯搬家):

- **压缩统一**:现在 loop 内联做自动压缩、`Agent.compactNow` 重写一遍手动压缩,两处重复 → `context/compact/compact.ts` 一个 `compactHistory()`,loop 与 `/compact` 都调它;
- **provider/model 解析统一**:`ProviderRegistry`、`isConfigured`、`Agent.currentProvider/currentModel` 三处各写一遍「从 config 找当前 provider+model」→ `config/resolve`,`ProviderRegistry` 类消解;
- **ToolResult 整形收口**:loop 内联的 `'content' in result ? truncate(...) : 'ERROR: ...'` → `context/message/tool-result.ts`。

## 6. ui:前端域(按原设计 §13 组件逐个成模块)

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
│     │  ├─ view-state.ts           # View 视图态联合(弹层状态机,纯)
│     │  ├─ keys.ts                 # 键盘路由:按键 → 视图/输入框/块浏览 的分发
│     │  └─ entry.ts                # renderTui(port):Ink render + 备用屏幕进出
│     ├─ chat/                      # §13 消息列表
│     │  ├─ index.ts
│     │  ├─ block.ts                # Block 模型 + 角色→图标/颜色映射
│     │  ├─ reducer.ts              # AgentToUiMessage → ChatState(纯)★新可单测
│     │  ├─ viewport.ts             # 行估算 + 滚动窗口裁切(纯)★新可单测
│     │  └─ browse.ts               # 块浏览焦点 + 折叠展开集合的管理(纯)
│     ├─ input/                     # §13 输入框
│     │  ├─ index.ts
│     │  ├─ commands.ts             # 斜杠命令表:/cmd → UiToAgentMessage(纯)★新可单测
│     │  └─ input-box.tsx           # 输入框组件 + 提交流程
│     ├─ overlays/                  # §13 叠加视图
│     │  ├─ index.ts
│     │  ├─ permission/
│     │  │  ├─ index.ts
│     │  │  ├─ decisions.ts         #   三决策选项 + 标签
│     │  │  └─ overlay.tsx          #   权限弹层视图
│     │  ├─ pickers/
│     │  │  ├─ index.ts
│     │  │  ├─ menu.ts              #   通用菜单机制(MenuItem/光标移动)
│     │  │  ├─ session-picker.tsx   #   会话选择器
│     │  │  └─ model-picker.tsx     #   模型两级选择器
│     │  ├─ prompt/
│     │  │  ├─ index.ts
│     │  │  └─ overlay.tsx          #   标量输入弹层(配置编辑用)
│     │  └─ config/
│     │     ├─ index.ts
│     │     ├─ entries.ts           #   buildEntries:config+路径 → 字段列表(纯)
│     │     ├─ navigation.ts        #   ConfigPath / parentPath 钻取导航(纯)
│     │     ├─ label.ts             #   entryLabel 渲染标签(纯)
│     │     └─ editor.tsx           #   配置编辑器视图
│     ├─ components/                # 无状态展示组件,一组件一文件夹(view + index)
│     │  ├─ top-bar/                #   ├─ index.tsx └─ view.tsx
│     │  ├─ message-block/          #   同上模式
│     │  ├─ status-bar/             #   同上模式
│     │  └─ list-picker/            #   同上模式
│     ├─ theme/                     # §14 视觉系统
│     │  ├─ index.ts
│     │  └─ palette.ts              #   Catppuccin Mocha 调色板
│     └─ markdown/                  # §10:markdown → 干净纯文本
│        ├─ index.ts
│        └─ render.ts
└─ test/                            # 镜像 src(见 §11)
```

- `App({ port }: { port: UiPort })`:所有 `agent.send(x)` → `port.post(x)`,`agent.on(cb)` → `port.onMessage(cb)`,**`import type { Agent }` 彻底删除**——解耦的落点;
- `renderTui(port)` 封装 Ink `render()` 与备用屏幕(alt-screen)进出(终端表现层事务,归 UI);
- 原 474 行 `index.tsx` 拆成 8 个模块,三个纯函数模块(reducer / viewport / commands)首次可直接单测;
- 原 164 行 `config-tree.ts` 拆成 entries / navigation / label 三个纯逻辑文件。

## 7. 组合根:根 `main.ts`

```ts
const config = loadConfig()                       // @dogegg/agent
const { agentPort, uiPort } = createChannelPair() // @dogegg/bridge
new Agent({ port: agentPort, config, cwd: process.cwd(), logDir })
renderTui(uiPort)                                 // @dogegg/ui
```

约 25 行,替代现在的 `src/main/{index,bootstrap}.ts`。

## 8. 模块内文件组织规则(硬规则,架构测试强制)

1. **每个模块文件夹必须有 `index.ts`**,且 index 只做导出汇总(≤30 行),不写任何逻辑;实现全部放在职责文件里。
2. **一职责一文件**:文件夹内按职责拆文件,禁止「一个 ts 文件写全部功能」。有多个可分职责(如工具的 schema 定义 vs execute 实现、SSE 的请求组装 vs 流读取 vs 重试)就必须分文件;确实只有一个职责的薄模块允许 index+单实现文件。
3. **体量红线**:源文件 ≤250 行(测试文件不受限),超出必须拆。
4. **跨模块 import 只指向入口**(文件夹的 index),不得深挖内部文件——相当于包级私有。
5. **工具模块强制模式**:每个工具文件夹至少 `schema.ts`(zod 定义 + JSON schema)+ `execute.ts`(实现)分立;`shell` 额外带 `interpreter.ts` 与 `kill-tree.ts`。

## 9. 工具链(workspaces 化的技术要点)

- **typecheck**:`tsc --noEmit -p tsconfig.json && tsc --noEmit -p agent && tsc --noEmit -p ui && tsc --noEmit -p bridge`。各包 tsconfig `extends ../tsconfig.base.json`;`moduleResolution: "bundler"` 让 `@dogegg/bridge` 经包 `exports` 解析到 `./src/index.ts` 源码(TS 原生支持,无需构建产物)。
- **build**:`build.mjs` 用 esbuild JS API——`bundle / platform=node / format=esm / packages: 'external'` 保持现状,加 ~10 行插件把 `@dogegg/*` 解析到对应包 `src/index.ts` 打进产物(npm 依赖保持 external,node 运行时从根 node_modules 取)。`--packages=external` 会把包名 import 全部外置,内部包必须由插件接管——workspaces 化唯一的新机关。
- **test**:根 `vitest.config.ts` 的 include 改为 `['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts']`,vitest 经 workspace 符号链接解析到 TS 源码,`npm test` 依旧一条命令跑全部。
- `npm run dev/start` 语义不变(build → `node dist/index.js`);`dist/` 仍从根产出;`.gitignore` 无需变化。

## 10. 边界强制:架构测试

`bridge/test/architecture.test.ts` 扫描三个包源码,断言三层:

**包级规则**:
1. `ui/src` 与 `agent/src` 不得出现 `@dogegg/agent` / `@dogegg/ui`(互不依赖);
2. `bridge/src` 不得出现 `@dogegg/agent` / `@dogegg/ui`(契约不反向依赖);
3. 三包 src 不得绕过包名用相对路径跨包 import(禁止 `../agent/...` 暗道;组合根 main.ts 除外)。

**子域依赖矩阵**(agent/ui 内部,只允许向下依赖,全部可依赖 bridge):

| agent 子域 | 允许依赖(内部) |
|---|---|
| shared / tools / llm / session / permission / config | — |
| state | —(零依赖纯函数) |
| context | llm(compact 调 adapter 做摘要), tools(tool-result 消费 ToolResult 类型) |
| loop | state, context, tools, permission, llm, shared |
| core | 全部 |

| ui 子域 | 允许依赖 |
|---|---|
| theme / markdown / input | — |
| components | theme |
| chat | components, theme, markdown |
| overlays | components, theme |
| app | 全部 |

**文件组织规则**(§8 的机械检查):index.ts 必须纯导出(≤30 行,无逻辑);src 下任何文件超 250 行即红;工具模块缺 `schema.ts`/`execute.ts` 分立即红。

## 11. 文件迁移映射

| 现文件 | 去向 |
|---|---|
| `src/events/types.ts` | `bridge/src/contract/shared.ts` |
| `src/events/agent-to-ui.ts` / `ui-to-agent.ts` | `bridge/src/contract/` 同名 |
| `src/config/schema.ts` | `bridge/src/contract/config.ts` |
| `src/agent/state.ts` | `agent/src/state/{events,transition}.ts` |
| `src/agent/index.ts` | `agent/src/core/{agent,commands,turn,pending}.ts` + `agent/src/config/editor/` |
| `src/agent/loop.ts` | `agent/src/loop/{types,run,tool-calls}.ts`(summarizeHistory 移入 `context/compact/summarize.ts`,与自动压缩共用) |
| `src/agent/context.ts` | `agent/src/context/{prompt/,message/,token/,compact/}` 按职责分拆 |
| `src/agent/session.ts` | `agent/src/session/{store,list}.ts` |
| `src/agent/permission.ts` | `agent/src/permission/{classify,runtime}.ts` |
| `src/llm/**` | `agent/src/llm/**`(provider/openai 与 streaming/openai 各自细分) |
| `src/tools/**` | `agent/src/tools/**`(每工具 schema+execute 分文件,shell 另带 interpreter/kill-tree) |
| `src/config/loader.ts` | `agent/src/config/loader/{find,load,save}.ts` |
| `src/common/errors.ts` + `utils/{id,token-count,truncate,logger,shell}.ts` | `agent/src/{shared,context/token,context/message,shared/logger,tools/shell}` 按消费域归属 |
| `src/common/utils/markdown.ts` | `ui/src/tui/markdown/render.ts` |
| `src/ui/tui/index.tsx` | `ui/src/tui/{app/,chat/,input/,overlays/}` 分域拆分 |
| `src/ui/tui/{components,config-tree}.ts(x)` | `ui/src/tui/components/` 一组件一文件夹;`ui/src/tui/overlays/config/{entries,navigation,label,editor}.ts(x)` |
| `src/main/{index,bootstrap}.ts` | 根 `main.ts` 合并 |
| 15 个 `test/**` | 按上表镜像进各包 `test/`(如 `test/agent/state.test.ts` → `agent/test/state/transition.test.ts`) |
| 新增 | `bridge/src/channel/`、`bridge/test/{channel,architecture}.test.ts`、`ui` 三个纯函数模块的测试 |
| 删除 | `src/`、`test/` 整目录 |

**文档同步**(CLAUDE.md 规则 2):同一改动里更新原设计文档 §9「目录结构」整节为新结构(注明 v1.1 结构决策:workspaces、Port、契约归属),并同步 CLAUDE.md 的分层命名与构建说明。

## 12. 验证口径(完成的定义)

1. `npm run typecheck` 绿;
2. `npm run test:run` 绿,覆盖 ≥ 现有 15 个测试文件的全部断言(新增 bridge 2 个 + ui 3 个纯函数测试);
3. `npm run build` 产出 `dist/index.js`,`npm start` 可启动 TUI,人工冒烟:发消息、`/config`、权限弹层、折叠展开;
4. `grep -r "@dogegg/agent" ui/src` 无结果——UI 零反向依赖;
5. 架构测试(包级 + 子域矩阵 + 文件组织)通过。

## 13. 非目标

- 不改任何运行时行为、消息契约语义、视觉呈现;
- 不做 WebUI/SSE 通道实现(仅保留 Port 接口的可扩展点);
- 不引入 monorepo 框架(nx/turbo/lerna),npm workspaces 裸用;
- 不拆独立构建流水线(三包不各自产 dist)。
