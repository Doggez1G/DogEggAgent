# OOP 重构设计：后端全仓类化（校准版）

> 状态：已实施（2026-09-07 完成，Phase 0–3 全部落地；172 测试 + 五路 typecheck + build 全绿）
> 日期：2026-09-07
> 前置：四包 workspaces 架构（2026-08-27 模块化重构）、Static 架构 TUI（ADR-0008）均已稳定
> 结论来源：2026-09-07 讨论——「全仓类化」校准为「**公共 API 全类 + 纯函数私有化收编 + 契约层保持纯数据**」；前端（ui 包）暂缓，本次只做后端（agent / bridge / server）。

## 1. 目标与范围

把后端从「函数 + 依赖对象/闭包/模块级单例」的混合风格，统一为**面向对象风格**，达成两个目标：

1. **通俗易懂**：装配方式只剩一种——「所有协作组件都是类，依赖一律从构造函数进来」。读者（或 AI）读代码只有一条路径：组合根看 new 了哪些类 → 每个类一个文件夹 → 依赖全在构造函数签名里。
2. **好维护**：变更局部化。加 provider = 新增一个 `LlmClient` 实现；加运行期工具 = 向 `ToolRegistry` 注册；改压缩策略 = 改一个类。

**硬约束**：

1. **行为零变化**：消息契约、状态机语义、压缩策略、权限语义、会话持久化格式、TUI/WebUI 交互全部不变。这是纯结构重构。
2. **解耦结构不变**：agent/ui 互不知晓、跨包只走 bridge Port 消息、barrel import 规则、架构测试全部继续生效。
3. **规模**：后端 101 文件 / 约 2,840 行，其中真正需要动脑的核心文件约 15–20 个，其余为机械搬运。

## 2. 编码约定（本次确立，写入后端全部模块）

1. **公共 API 全类**：跨模块可见的有状态/有 I/O/有生命周期的组件一律是类；依赖经构造函数注入；字段 `private readonly` 优先。
2. **纯计算私有化**：无状态计算（估算、截断、切分、路径文法）降级为所在类的私有方法或模块内私有函数，外界不可见。极少数收不进任何类的纯工具（如 `newId()`）保留函数形态。
3. **契约层排除**：bridge 的消息 union / zod schema / Config 类型保持纯数据——跨进程边界上永远是数据，边界内才谈对象。
4. **组合而非继承**：只允许 `implements 接口` 与对象组合，禁止深层继承树（`extends Error` 的错误类除外）。
5. **接口只为真实接缝而建**：已有 `AgentPort`/`UiPort`/`Tool`/`LlmClient` 四个接缝接口，不为单实现组件造新接口。
6. **模块 = 文件夹 + index.ts 纯 re-export** 不变（架构测试守门）；类文件命名 kebab-case（工具目录沿用既有 snake_case）。

## 3. 重构后的后端框架图

```
agent 包（公共协作组件全是类）
├─ Agent                  门面：port 订阅 + 消息路由（Phase 3 拆瘦）
│   ├─ StateMachine       10 态迁移封装（收编 core/state/transition 纯函数表）
│   ├─ BusyGate           running/cancelled/controller 三态并发闸门（Phase 3 抽出）
│   ├─ Conversation       工作集：history/context/thinking/sessionId/cwd（Phase 3 抽出）
│   ├─ PendingPermissions 已有
│   ├─ PermissionManager  已有（classify 收编为私有方法）
│   ├─ ConfigStore        配置查找/读取/落盘（收编 config/loader 三函数文件）
│   │   └─ ConfigEditor   已有（mutate/paths/validate 保持模块私有实现）
│   ├─ SessionStore       会话持久化 + 列表（收编 session/store + list）
│   ├─ ContextAssembler   system prompt 加载 + token 预算估算（收编 context/prompt、token/budget）
│   ├─ Logger             日志实例（消灭模块级 logDir 全局；tail 收编）
│   ├─ ToolRegistry       活注册表（消灭 import 期固化的 toolSchemas()）
│   │   └─ ReadFileTool / WriteFileTool / EditFileTool / ShellTool
│   ├─ OpenAiClient implements LlmClient   （收编 adapter；conn=baseURL/apiKey 归实例）
│   ├─ AgentLoop          主循环（收编 loop/run；LoopDeps 拆为构造服务 + run 轮次参数）
│   │   └─ ToolExecutor   单工具执行（收编 loop/tool-calls）
│   └─ Compactor          压缩编排（收编 context/compact 四件套的触发/切分/编排）
└─ resolveCurrent 等      纯查询保持模块内函数（不跨模块暴露）

bridge 包
├─ InMemoryChannel        同进程通道（收编 createChannelPair 工厂闭包）
└─ contract/              ★ 纯数据 + zod schema，不类化

server 包
├─ SseChannel implements AgentPort   SSE 通道（闭包收编为字段；本身即 AgentPort）
├─ HttpServer             HTTP server + CORS + 分发（收编 http/server + routes 的 dispatch）
├─ Router                 API 路由表（收编 routes.ts 路由表部分）
├─ StaticFiles            静态文件 + SPA fallback + 穿越防护（收编 serveStatic）
├─ FsBrowser              目录浏览（收编 fs/browse）
└─ ShellDetector          shell 检测 + 缓存（消灭模块级缓存单例）
```

## 4. 分阶段实施

### Phase 0：测试安全网（先行，动刀前锁行为）

- `Agent` 构造函数加可选注入参数（测试接缝，行为不变）：`opts?: { adapter?: ProviderAdapter; sessionsDir?: string }`——adapter 覆盖 `adapterFor()`、sessionsDir 覆盖 `defaultSessionsDir()`。
- 新增 `agent/test/core/agent.turn.test.ts` 表征测试（全部走 Port 黑盒，重构后必须原样通过）：
  1. 完整轮次含工具调用（事件序列：message(user) → tool_start → tool_end → message(assistant) → finished）；
  2. ask 权限流（permission_request → permission_decision → 执行 → finished）；
  3. 轮次取消（AbortError 路径 → notice「已打断」）；
  4. 手动压缩（/compact → compaction source=manual）；
  5. 会话持久化 + resume（跨 Agent 实例恢复 history/thinking/allowedTools）。

### Phase 1：机械类化（行为零变化的热身）

| 目标 | 收编 | 调用点更新 |
|---|---|---|
| `bridge/channel/in-memory.ts` → `InMemoryChannel` 类 | createChannelPair 闭包 | bin/dogegg.ts、main.ts、bridge/channel 测试、agent 测试 |
| `server/channel/sse.ts` → `SseChannel implements AgentPort` | sseHandler/postHandler 闭包 | bin/dogegg.ts、main-web.ts、server 测试（Agent 直接收 channel 当 port） |
| `server/http/` → `HttpServer` + `Router` + `StaticFiles` 类 | startServer/createRoutes/dispatchRequest/serveStatic | 同上组合根 |
| `server/fs/browse.ts` → `FsBrowser`；`server/shells/detect.ts` → `ShellDetector` | 函数组 + 缓存单例 | Router 构造注入 |
| `agent/session/` → `SessionStore` 类 | store/list 函数组 + baseDir 参数穿线 | Agent（构造注入，默认 `~/.dogegg/sessions`）、session 测试 |
| `agent/shared/logger/` → `Logger` 类 | init/write/tail + logDir 全局 | 组合根（new Logger 传入 Agent）、agent.ts 调用点、logger 测试 |

### Phase 2：agent 主体类化

1. **ToolRegistry + 工具类化**：四工具 `execute.ts` 收编为类方法；`registry.ts` 裸数组 → `ToolRegistry` 类，`schemas()` 每次现算；`loop/run.ts:13` 的 import 期固化 `toolParams` 消灭。
2. **LlmClient 类化**：接口 `ProviderAdapter` → `LlmClient`；`ChatRequest` 瘦身（baseURL/apiKey 移入 client 实例）；`adapter.ts` → `OpenAiClient` 类（stream/request 成为模块私有实现，conn 参数化）；`adapter-for.ts` → `clientFor(protocol, conn)` 工厂。
3. **AgentLoop 类化**：`runLoop(deps)` → `AgentLoop`（构造注入 registry/permission/emit/requestPermission/checkCancelled/trans/summarize/maxIterations，`run(turn)` 收轮次参数）；`tool-calls.ts` → `ToolExecutor` 类；内部局部 `state` 换 `StateMachine` 实例。
4. **支撑类**：`StateMachine`（收编 transition 表）、`Compactor`（收编 compact/trigger/split 编排，summarize 回调注入）、`ContextAssembler`（prompt + budget）、`ConfigStore`（收编 loader）。

### Phase 3：Agent 门面拆分

`agent.ts`（435 行）拆为路由门面 + 协作类：`Conversation`（工作集）、`BusyGate`（并发闸门）、`TurnRunner`（submit/cancel/compact）、`SessionManager`（new/resume/delete/list/clear）、`ConfigController`（config_set/add/remove/request）；纯查询（status/tools/context/system/log/permissions）留在 Agent 直接 emit。拆分全程以 Phase 0 表征测试为行为基线。

### 每阶段验证口径

`npm run typecheck` + `npm run test:run`（167+ 测试）+ `npm run build`；跨包 import 与 barrel 规则由架构测试自动守门；每个 Phase 一次独立提交（文件重命名与逻辑收编不混提交）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| loop/压缩/权限联动回归 | Phase 0 表征测试先行；每步全量测试 |
| 双状态跟踪（Agent 与 loop 各有一份 state）迁移出错 | StateMachine 只替换容器不改迁移表语义；transition 纯函数保留为内部实现并有既有测试 |
| SSE/组合根接线变化引入启动问题 | 组合根改动后 `npm run build` + TUI/WebUI 双冒烟 |
| 大搬运提交不可审 | 逐类小步提交；重命名与逻辑修改分离 |

## 6. 非目标

- 前端（ui 包）类化——暂缓，后端完成后另行评估（React 组件保持函数组件是既定结论）；
- 事件总线（OpenCode Bus 式）——不引入，Agent 拆分用「处理类路由」达到同等解耦；
- 目录大重组——模块=文件夹结构保持，仅文件级重命名；
- 任何行为变更、新特性、消息契约改动。

## 7. 实施结果与计划的偏差

- **Agent 门面 333 行**：纯查询（status/tools/context/system/log/permissions）与 set_cwd、quit 留在 Agent 直接 emit——它们只读协作类，拆出去需传 5+ 个回调，得不偿失。
- **LoopDeps 拆为 LoopServices + TurnInput**：`trans` 回调从 loop 依赖中删除——loop 持有自己的 StateMachine 实例，Agent 侧经 emit() 收到 state 事件后用 `machine.sync()` 镜像（替代旧的 `this.state = m.to`）。permission/maxIterations 归 TurnInput（config 编辑重建的实例下一轮生效，无需重建 AgentLoop）。
- **TurnParams**：Agent.turnParams() 组装 provider 连接与模型参数，client 测试覆盖在此生效；TurnRunner 经 deps.turnParams() 取用。
- **ConfigStore 替换 loadConfig/saveConfig**：agent 包公共 API 变为 Agent / AgentOptions / ConfigStore / Logger；组合根改 `new ConfigStore().load()`。
- **Conversation 用显式访问方法**（getId/getCwd/getContext/…）而非属性 getter——私有字段与同名 getter 会冲突。
- **Router 的 fs/shells 依赖可注入、缺省自建**——组合根保持一行装配；HttpServer 内部持有 StaticFiles（staticDir 为 null 时不建）。
