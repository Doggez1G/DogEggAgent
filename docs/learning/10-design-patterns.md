# 10 · 跨切面设计模式

本文总结贯穿整个项目的 8 个设计模式——它们不是某个模块独有的，而是全局一致的设计哲学。

## 1. 依赖注入（Dependency Injection）

loop 不直接 import llm、permission、session——跨轮次稳定的服务经构造函数注入（`LoopServices`），每轮参数收在 `run(turn)` 的 `TurnInput`：

```ts
interface LoopServices {
  registry: ToolRegistry          // 工具注册表（怎么执行工具）
  emit / requestPermission / checkCancelled / summarize
}

interface TurnInput {
  client: LlmClient               // 怎么调 LLM（OpenAiClient 实例）
  context / systemPrompt / windowTokens / permission / maxIterations / cwd / signal
}
```

- `Compactor` 的 `summarize` 回调——压缩不直接依赖 llm client，agent 注入。
- `ToolExecutor.execute()` 的 `trans` 回调——工具执行不直接调状态机，通过回调迁移。

## 2. 纯函数状态机 + 守卫表

所有状态迁移经 `transition(s, input)` 纯函数。VALID_FROM 守卫表防止非法迁移。`trans` 闭包统一出口——先 transition 算下一态，再 emit state 事件。

```ts
const trans = (input) => {
  const next = transition(state, input)
  if (next !== state) deps.emit({ type: 'state', from: state, to: next })
  return next
}
```

**好处**：状态迁移集中一处，不会散落在各处直接改 state。非法迁移被守卫拦截而非崩溃。

## 3. Error-as-Value（不抛异常）

工具返回 `{content} | {error}` 而非 throw。工具执行包 try/catch 保证 tool_start 有配对 tool_end。loop catch 所有错误返回部分结果而非抛出。

```ts
// 工具
type ToolResult = { content: string } | { error: string }

// 工具执行
try { result = await tool.execute(args, ctx) }
catch (e) { emit tool_end with error; return error message }

// loop
catch (e) {
  patchUnpairedToolCalls(context)
  return { context, newMessages, cancelled: true / error: msg }
}
```

**好处**：工具失败不中断 loop——错误成为 tool 消息回填模型，模型知道工具失败了可以调整策略。

## 4. Discriminated Union（标签联合）

消息契约、迁移输入、配置操作都用 discriminated union：

```ts
type AgentToUiMessage = | { type: 'state'; ... } | { type: 'text_delta'; ... } | ...
type TransitionInput = | { kind: 'submit'; ... } | { kind: 'tool_calls'; ... } | ...
type ConfigSetOp = | { kind: 'top'; ... } | { kind: 'provider'; ... } | ...
```

**好处**：TypeScript 的穷尽检查确保 switch 不漏 case。新增变体时编译器报错提醒所有 switch 补 case。

## 5. History/Context 双写分离（R1）

每条新消息同时 push 到 history（完整原文，永不压缩）和 context（发给模型，可压缩）。压缩只改 context。Session 文件分别存两者。

```ts
// 双写
this.history.push(userMsg)
this.context.push(userMsg)

// loop 返回后
this.context = result.context         // 可能被压缩
this.history.push(...result.newMessages)  // 只 append，不受压缩影响
```

**好处**：resume 后 UI 显示完整历史（history），模型用压缩后的上下文（context）。两者各司其职。

## 6. 事务性配置编辑（lastGood 快照）

ConfigEditor 持有 config + lastGood 快照。任何编辑后统一重校验，失败回滚到 lastGood：

```ts
private afterEdit() {
  const result = validateConfig(this.config, this.lastGood)
  if (!result.ok) {
    this.config = structuredClone(result.config)  // 回滚
    return { ok: false, error: result.error }
  }
  this.lastGood = structuredClone(this.config)  // 更新快照
  return { ok: true }
}
```

**好处**：用户不会处于半写坏的配置状态。zod 校验 + 重名检查 + 回滚全自动。

## 7. 取消三件套（Cancellation Trilogy）

三种机制协同保证取消可靠：

1. **AbortController 中断 fetch**：`controller.abort()` → fetch 抛 AbortError → loop catch 转 CancelledError。
2. **signal listener 杀进程**：`ctx.signal.addEventListener('abort', () => killTree(child))` → shell 子进程被杀。
3. **checkCancelled 轮询**：loop 每次迭代和工具间检查 `this.services.checkCancelled()` → 抛 CancelledError。

加上 `withRetry` 的 abortable sleep（退避期间 cancel 能中断），覆盖了所有可能的等待点。

## 8. 模块 = 文件夹，index.ts = 纯导出

每个模块是文件夹，`index.ts` 只做 re-export（架构测试强制）。实现写在兄弟文件。跨模块 import 只指向 index.ts。

```
tools/
├─ index.ts           # export { ToolRegistry, ReadFileTool, ..., type Tool }
├─ registry.ts        # ToolRegistry 类实现
├─ types.ts           # 类型定义
├─ read_file/
│  ├─ index.ts        # export { ReadFileTool } from './tool'
│  ├─ schema.ts       # zod schema + OpenAI JSON schema
│  └─ tool.ts         # ReadFileTool 类实现
```

**好处**：模块的公开 API 清晰（看 index.ts 就知道）。改实现不影响导入方（路径不变）。架构测试能自动检测 index.ts 是否塞了实现。

---

## 学习路径建议

1. **先读 bridge**：理解消息契约和 Port——这是整个解耦的基础。
2. **再读 state machine**：理解 10 个状态和迁移规则——这是 agent 的行为骨架。
3. **然后读 loop**：理解核心循环——这是 agent 的心脏。
4. **接着读 tools + llm**：理解工具执行和 LLM 调用——这是 agent 的手脚。
5. **最后读 context + session + config**：理解数据管理——这是 agent 的记忆。
6. **UI 最后读**：理解渲染和交互——这是用户看到的。

从 `bin/dogegg.ts` 开始（统一 CLI 入口），追踪一条消息的完整路径：

```
用户输入 "帮我读 package.json"
→ UI handleSubmit → port.post({ type: 'submit', text: '...' })
→ Agent.send → TurnRunner.submit → AgentLoop.run
→ OpenAiClient.chat → fetch SSE → parser.feed → text_delta emit
→ 模型返回 tool_calls → ToolExecutor.execute → read_file execute
→ tool_end emit → 结果回填 → 再问模型 → final_answer
→ return { context, newMessages } → agent 保存 → emit finished
→ UI reducer 更新 blocks → 状态栏 idle
```

这条路径经过几乎所有模块，理解它就理解了 code agent 的完整工作原理。
