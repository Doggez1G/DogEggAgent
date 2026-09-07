# 03 · turn：一轮对话的完整故事

> `turn/` 是后端的心脏。用户按一次回车到「回答完成 / 被取消 / 出错」之间的全部机制都在这里。
> 本章按「一次带工具调用的提交」的时间顺序走读。

## 文件清单（每个文件 = 故事的一个角色）

```
turn/
├─ turn-runner.ts    # 编排：submit/cancel/compact 的实现，占闸门、落盘
├─ loop.ts           # 主循环：问模型 → 执行工具 → 回填 → 再问
├─ tool-executor.ts  # 单个工具调用的完整流程（权限三分支在这）
├─ state.ts          # 10 态状态机（迁移表 + 机器封装，一个文件讲完）
├─ gate.ts→shared    # 并发闸门（归 shared：session 也要读）
├─ pending.ts        # 权限挂起表（ask 时的 await 点）
├─ compactor.ts      # 压缩编排（机制，见 04 章）
├─ summarize.ts      # 压缩摘要的 LLM 调用（机制）
└─ types.ts          # LoopServices / TurnInput / LoopResult
```

## 状态机：一轮的生命周期

`state.ts` 用三段讲完一个状态机：输入类型、迁移表、机器封装。

```ts
export type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }
  | { kind: 'tool_calls' } | { kind: 'tool_needs_permission' } | { kind: 'allow' }
  | { kind: 'tool_done' } | { kind: 'reject'; reasoning: boolean } | { kind: 'result_back'; reasoning: boolean }
  | { kind: 'compact_start' } | { kind: 'compact_done'; next: State }
  | { kind: 'cancel' } | { kind: 'error' } | { kind: 'reset' }
  | ...
```

10 个状态：`idle → thinking/responding → tool_calling → executing/waiting_permission → （回到 tool_calling 或）→ finished/cancelled/error`。

两个关键设计：

1. **VALID_FROM 防护**——每种输入只能从特定状态触发，非法组合原地不动。这让「重复 fire」幂等，也让非法状态序列在结构上不可能出现。
2. **reasoning 参数**——`reject/result_back` 之后「重新问模型」与 submit 一样：推理模型回 `thinking`、普通模型回 `responding`，所以迁移输入要带上这个标志。

**全项目只有一台机器**（`ctx.machine`）：loop 在轮内 fire 它，门面的 `emitState` 在轮外（压缩、复位）fire 它。历史上的双机镜像（两台机器靠事件同步）已删除——两个事实源靠约定同步是维护陷阱。

## 主循环 loop.ts：骨架走读

```ts
export class AgentLoop {
  constructor(private readonly services: LoopServices) {}   // registry/machine/compactor/emit/权限/取消

  async run(turn: TurnInput): Promise<LoopResult> {
    const context = [...turn.context]        // ① 拷贝！loop 不碰调用方原数组
    const newMessages: Message[] = []        // ② 本轮新增消息（回填 history 用）
    const machine = this.services.machine    // ③ 唯一状态机
    const executor = new ToolExecutor({...}) // 每轮新建：permission 是轮次参数

    const trans = (input) => {               // 状态迁移唯一出口：fire + 变化才 emit
      const prev = machine.state
      const next = machine.fire(input)
      if (next !== prev) this.services.emit({ type: 'state', from: prev, to: next })
      return next
    }

    try {
      let state = trans({ kind: 'submit', reasoning: turn.reasoning })
      for (;;) {
        if (checkCancelled()) { trans({ kind: 'cancel' }); throw new CancelledError() }
        if (iterations++ >= turn.maxIterations) { /* error 上抛 */ }

        // 自动压缩：token 超窗口 80% → Compactor（04 章）
        // 调模型（流式）：
        result = await turn.client.chat({ model, systemPrompt, messages: context, tools }, turn.signal, (e) => {
          // text_delta / thought_delta 实时转发给 UI
        })
        thinking.push(...)                     // 每轮推理内容（resume 恢复思考块用）
        context.push(assistant); newMessages.push(assistant)

        const calls = assistant.tool_calls ?? []
        if (calls.length === 0) { trans({ kind: 'final_answer' }); return { context, newMessages, thinking } }

        // 串行执行工具，逐个回填
        for (const [i, call] of calls.entries()) {
          const step = await executor.execute(call, ctx, { isLast, reasoning }, trans)
          context.push(step.toolMessage); newMessages.push(step.toolMessage)
          state = trans(step.transitionInput)
        }
      }
    } catch (e) {
      patchUnpairedToolCalls(context)          // 取消/出错时补全未配对 tool_calls（下述）
      if (e instanceof CancelledError) return { context, newMessages, thinking, cancelled: true }
      return { context, newMessages, thinking, error: (e as Error).message }
    }
  }
}
```

三个必懂的细节：

1. **R1 双写分离**：loop 只操作 `context`（发给模型的，会被压缩），本轮新增的消息装进 `newMessages` 返回，由 session 的 conversation 同步进 `history`（完整原文、永不压缩）。出错也不丢——loop 把已完成的部分作为结果返回而不是抛掉。
2. **补全未配对 tool_calls**（`patchUnpairedToolCalls`）：OpenAI API 要求 assistant 的每个 tool_call 必须有配对的 tool 消息，否则 400。取消发生在两个工具之间时，loop 向后扫描最后一条带 tool_calls 的 assistant，为每个没配对的调用补一条「cancelled」消息。
3. **AbortError ≠ 错误**：用户取消时在飞的 fetch 抛 AbortError，loop 把它识别为取消（转 `CancelledError` 走中断保存路径），其它错误才走 error 态。

## tool-executor.ts：权限三分支与 R3

每个 tool_call 的处理流程：未知工具 → 参数解析（zod）→ 权限分类 → 执行/拒绝。

```ts
const verdict = this.services.permission.classify(tool.name)
if (verdict === 'reject') { /* 发 tool_end（error: denied）+ 回填拒绝消息 */ }
if (verdict === 'ask') {
  trans({ kind: 'tool_needs_permission' })
  const decision = await this.services.requestPermission(tool.name, args)  // 挂起等用户决议
  if (decision === 'reject') { /* 同样发 tool_end（denied） */ }
  trans({ kind: 'allow' })  // → executing
}
```

**R3 原则：拒绝、未知工具、参数校验失败也发 `tool_end`（带 error 标记）**——UI 能显示「🐾 tool ✕ denied」，而且拒绝消息明确告诉模型「不要重试同一工具」，避免权限死循环。工具抛异常同样被 catch 成 tool_end——`tool_start` 永远有配对的 `tool_end`。

`requestPermission` 这个回调是**未来的 SDK 注入点**：无头使用时可以注入程序化决议，不经过 UI 往返。

## gate 与 pending

- **BusyGate**（`shared/gate.ts`）：同一时刻只允许一个「动 context」的操作（轮次或压缩）在飞。运行中再提交/改配置会被「运行中，请稍候」挡下（R2）。它同时承载两套取消语义（轮询检查点 + AbortSignal 在飞中断），立法注释见文件头。
- **PendingPermissions**：ask 分支挂起的 Promise 表。`requestPermission` 创建挂起项并发 `permission_request`，用户决议到达时 `resolve`——这就是「agent 可以 await 用户输入」的实现方式。

## 三个类型，一条数据流

| 类型 | 方向 | 内容 |
|---|---|---|
| `TurnParams` | 门面 → TurnRunner | 仅 provider 连接参数（命令时刻解析的**值**） |
| `TurnInput` | TurnRunner → AgentLoop | 完整轮输入：+context / permission / cwd / signal |
| `LoopResult` | AgentLoop → conversation | 压缩后的 context + newMessages + thinking + cancelled/error |

名字相近但生命周期不同：`TurnParams` 是一次命令的快照，`TurnInput` 是正在运行的一轮。
