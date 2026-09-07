# 03 · Agent Loop 核心循环

## 核心循环是什么

Agent Loop 是 code agent 的心脏——它实现了"问模型 → 有工具调用就执行 → 结果回填 → 再问"的循环，直到模型不再调用工具（给出最终答案）或触发停止条件。

```
用户提问 → 问模型 → 模型返回 tool_calls？
                         │
                    ┌────┴────┐
                    是         否 → 最终答案，结束
                    │
              串行执行工具 → 结果回填 → 再问模型 ↑
```

## AgentLoop 类（run 方法）

```ts
// agent/src/turn/loop.ts —— OOP 重构后：构造注入跨轮次服务（LoopServices），run() 收单轮参数（TurnInput）
export class AgentLoop {
  constructor(private readonly services: LoopServices) {
    this.compactor = new Compactor(services.summarize)   // 压缩编排收编为 Compactor 类
  }

  async run(turn: TurnInput): Promise<LoopResult> {
    const context = [...turn.context]        // 拷贝 context（不修改原数组）
    const newMessages: Message[] = []        // 本轮新增消息（供 agent 同步到 history）
    const thinking: { text: string }[] = []  // 每轮 reasoning 收集，不进 history/context
    const machine = new StateMachine('idle') // loop 自己的状态机（Agent 侧另有一份镜像）
    const executor = new ToolExecutor({      // 每轮新建：permission 是轮次参数（config 编辑要生效）
      registry, permission: turn.permission, emit, requestPermission,
    })
    let iterations = 0

    // 状态迁移的唯一出口：StateMachine.fire 算下一态，变化才 emit
    const trans = (input: TransitionInput): State => {
      const prev = machine.state
      const next = machine.fire(input)
      if (next !== prev) this.services.emit({ type: 'state', from: prev, to: next })
      return next
    }

    try {
      let state = trans({ kind: 'submit', reasoning: turn.reasoning })

      for (;;) {
        // 1. 检查取消
        if (this.services.checkCancelled()) { trans({ kind: 'cancel' }); throw new CancelledError() }
        // 2. 检查迭代上限
        if (iterations++ >= turn.maxIterations) { trans({ kind: 'error' }); throw new Error('达到 maxIterations 上限') }

        // 3. 自动压缩（token 超 80% 窗口）——Compactor.compact，失败降级继续
        const used = estimateContextTokens(turn.systemPrompt, context, this.services.registry.schemas())
        if (used > turn.windowTokens * 0.8) {
          // compact_start → Compactor.compact → compact_done → enforceContextLimit 硬上限兜底
        }

        // 4. 调模型（流式）——连接参数归 OpenAiClient 实例所有，请求只带 model/messages/tools
        let result
        try {
          result = await turn.client.chat({ model: turn.model, systemPrompt: turn.systemPrompt, messages: context, /* ... */ }, turn.signal, (e) => {
            if (e.type === 'text_delta') {
              if (state === 'thinking') state = trans({ kind: 'thought_done' })  // reasoning 结束
              this.services.emit({ type: 'text_delta', delta: e.text })
            } else if (e.type === 'thought_delta' && turn.reasoning) {
              this.services.emit({ type: 'thought_delta', delta: e.text })
            }
          })
        } catch (e) {
          // 取消引发的 AbortError 视为取消而非错误，转成 CancelledError 上抛
          if ((e as Error).name === 'AbortError') { trans({ kind: 'cancel' }); throw new CancelledError() }
          trans({ kind: 'error' }); throw e
        }

        const assistant = result.message
        // 每轮 LLM 调用收集一个 thinking 条目；reasoning 关闭时存空字符串（不显示思考气泡）
        thinking.push({ text: turn.reasoning ? (result.reasoning ?? '') : '' })
        context.push(assistant)
        newMessages.push(assistant)
        this.services.emit({ type: 'message', role: 'assistant', id: newId() })

        // 5. 有 tool_calls？无 → final_answer + finished，返回
        const calls = assistant.tool_calls ?? []
        if (calls.length === 0) {
          trans({ kind: 'final_answer' })
          this.services.emit({ type: 'finished' })
          return { context, newMessages, thinking }
        }
        state = trans({ kind: 'tool_calls' })

        // 6. 串行执行工具（ToolExecutor 类）
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          if (this.services.checkCancelled()) { trans({ kind: 'cancel' }); throw new CancelledError() }
          const step = await executor.execute(
            call,
            { cwd: turn.cwd, signal: turn.signal, shellProgram: turn.shellProgram },
            { isLast: i === calls.length - 1, reasoning: turn.reasoning },
            (input) => { state = trans(input) },
          )
          context.push(step.toolMessage)
          newMessages.push(step.toolMessage)
          state = trans(step.transitionInput)
        }
        // 回到 for(;;) 顶部，再问模型
      }
    } catch (e) {
      // 中断/错误：补全未配对的 tool_calls，返回部分结果
      patchUnpairedToolCalls(context)
      if (e instanceof CancelledError) return { context, newMessages, thinking, cancelled: true }
      return { context, newMessages, thinking, error: (e as Error).message }
    }
  }
}
```

## 关键设计点

### 1. context 是拷贝

```ts
const context = [...turn.context]
```

loop 操作的是 context 的拷贝——push、压缩都在这个拷贝上。成功时返回 `result.context`，agent 赋值给 `this.context`。这样即使中途出错，`this.context` 不被污染。

### 2. newMessages 双写

每条 assistant/tool 消息同时 push 到 `context`（发给模型）和 `newMessages`（返回给 agent 同步到 history）。但 history 不受压缩影响——压缩只改 context，history 是完整原文。

```ts
// agent/src/session/conversation.ts applyTurnResult()
this.context = result.context         // 更新 context（可能被压缩）
this.history.push(...result.newMessages)  // 同步到 history（不被压缩）
```

### 3. 中断保存 + 补全 tool_calls

用户 Ctrl+C 打断时，loop catch CancelledError，返回部分结果（已完成的 assistant/tool 消息）。但如果有 assistant 带了 tool_calls 却没有配对的 tool 结果（比如 tool 1 执行完、tool 2 被取消），OpenAI API 会报 400——每个 tool_call 必须有配对的 tool 消息。

`patchUnpairedToolCalls` 扫描全部消息找最后一条带 tool_calls 的 assistant，为每个未配对的 tool_call 补一条 `tool: cancelled` 消息：

```ts
const patchUnpairedToolCalls = (msgs: Message[]): void => {
  // 向后扫描找最后一条带 tool_calls 的 assistant（不要求在数组尾部！）
  let lastAssistantIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.role === 'assistant' && m.tool_calls?.length) { lastAssistantIdx = i; break }
  }
  if (lastAssistantIdx < 0) return
  // 收集此 assistant 之后所有已配对的 tool_call_id
  const paired = new Set<string>()
  for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
    if (msgs[i]!.role === 'tool') paired.add(msgs[i]!.tool_call_id)
  }
  // 为未配对的补 cancelled 消息
  for (const tc of assistant.tool_calls) {
    if (!paired.has(tc.id)) {
      const cancelledMsg = { role: 'tool', tool_call_id: tc.id, content: 'cancelled（用户打断了操作）' }
      msgs.push(cancelledMsg)
      newMessages.push(cancelledMsg)
    }
  }
}
```

### 4. 错误路径也保存

错误（maxIterations / API 失败）不抛异常，而是返回 `{ context, newMessages, error: msg }`。agent 收到后保存已完成的工具执行，发 error 消息——50 轮工具执行的副作用不丢失。

### 5. 流式回调

`turn.client.chat(req, signal, emit)` 的第三个参数是流式回调——每收到一个 `text_delta` 或 `thought_delta` 就立即 emit 给 UI。UI 据此实时渲染流式文本。

推理模型的 `thought_done` 迁移在 `text_delta` 第一次到达时触发——因为推理模型先吐 reasoning（`thought_delta`），再吐正文（`text_delta`），第一次收到 `text_delta` 意味着 reasoning 结束。

### 6. 每轮思考收集（thinking）

loop 维护一个 `thinking: { text: string }[]` 数组，每次 LLM 调用后 push 一个条目（agent-loop.ts）：

```ts
thinking.push({ text: deps.reasoning ? (result.reasoning ?? '') : '' })
```

每条 assistant 消息对应一个 thinking 条目（含 `content=null` 的纯 tool_calls 消息）。只在 `deps.reasoning`（当前模型开启思考）时才记录实际 reasoning 内容；关闭思考时存空字符串——不记录、不显示。thinking 不进 history/context，单独随 `LoopResult` 返回，由 agent 持久化到 session 文件，resume 后恢复思考块显示。UI 端 `rebuildBlocksFromHistory` 按 1:1 对齐 assistant 消息与 thinking 条目，空字符串条目被跳过（不显示思考气泡）。

### 7. 硬上限兜底（enforceContextLimit）

压缩后若 context 仍超 80% 窗口（单条消息极大，或压缩失败降级仍用未压缩 context），`enforceContextLimit` 从头部丢弃最旧的非 system 消息直到降到阈值以下，保留至少一条消息确保模型看到最新输入（agent-loop.ts）。被丢弃的消息在 history 中仍保留——只是不再发给模型，UI 显示不受影响。

### 8. AbortError → CancelledError

`adapter.chat` 调用裹在 try/catch 中（agent-loop.ts）。用户取消时正在飞的 fetch 会抛 `AbortError`——loop 把它识别为取消而非错误，迁移到 `cancelled` 态并转成 `CancelledError` 上抛，由外层 catch 走中断保存路径。其它错误迁移到 `error` 态后原样上抛。

## LoopServices + TurnInput：依赖注入

OOP 重构后 loop 是类。构造期注入跨轮次稳定的服务（`LoopServices`），每轮参数收在 `run(turn)` 的 `TurnInput` 里——config 编辑（换 provider、改 maxIterations、重建 PermissionManager）只影响下一次 run，无需重建 AgentLoop：

```ts
// 构造期：跨轮次稳定
interface LoopServices {
  registry: ToolRegistry              // 工具注册表（schemas() 每次现算）
  emit: (e) => void                   // 发 UI 事件
  requestPermission: (...) => ...     // 权限请求
  checkCancelled: () => boolean       // 取消检查
  summarize: (old, signal?) => ...    // 压缩摘要（agent 注入）
}

// 单轮：provider 连接与工作集
interface TurnInput {
  client: LlmClient                   // LLM 客户端（OpenAiClient 实例）
  model / maxOutput / maxRetries / reasoning
  systemPrompt / windowTokens
  context: Message[]                  // 发给模型的消息
  permission: PermissionManager       // 权限管理（每轮最新实例）
  maxIterations / cwd / shellProgram / signal
}
```

这让 loop 可独立测试——注入 fake client（脚本化返回），不联网跑。

## 打断保存策略总结

| 数据 | 打断时 | 理由 |
|---|---|---|
| user 消息 | ✅ 保存 | 完整意图 |
| 已完成 assistant + tool | ✅ 保存 | 有价值 |
| 未配对 tool_calls | ✅ 补 cancelled | API 要求配对 |
| 部分流式文本 | ❌ 不保存 | 半句话无价值 |
| 压缩结果（被中断） | ❌ 不保存 | 没完成 |
