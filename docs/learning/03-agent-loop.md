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

## runLoop 函数

```ts
// agent/src/loop/run.ts
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const context = [...deps.context]   // 拷贝 context（不修改原数组）
  const newMessages: Message[] = []    // 本轮新增消息（供 agent 同步到 history）
  let state: State = 'idle'
  let iterations = 0

  // 状态迁移的唯一出口
  const trans = (input: TransitionInput): State => {
    const next = transition(state, input)
    if (next !== state) deps.emit({ type: 'state', from: state, to: next })
    return next
  }

  try {
    state = trans({ kind: 'submit', reasoning: deps.reasoning })

    for (;;) {
      // 1. 检查取消
      if (deps.checkCancelled()) { state = trans({ kind: 'cancel' }); throw new CancelledError() }
      // 2. 检查迭代上限
      if (iterations++ >= deps.maxIterations) { state = trans({ kind: 'error' }); throw new Error('达到 maxIterations 上限') }

      // 3. 自动压缩（token 超 80% 窗口）
      const used = estimateContextTokens(deps.systemPrompt, context, toolParams)
      if (used > deps.windowTokens * 0.8) { ... 压缩 ... }

      // 4. 调模型（流式）
      assistant = await deps.adapter.chat({ ...messages: context... }, deps.signal, (e) => {
        if (e.type === 'text_delta') {
          if (state === 'thinking') state = trans({ kind: 'thought_done' })  // reasoning 结束
          deps.emit({ type: 'text_delta', delta: e.text })
        } else if (e.type === 'thought_delta' && deps.reasoning) {
          deps.emit({ type: 'thought_delta', delta: e.text })
        }
      })

      context.push(assistant)
      newMessages.push(assistant)
      deps.emit({ type: 'message', role: 'assistant', id: newId() })

      // 5. 有 tool_calls？
      const calls = assistant.tool_calls ?? []
      if (calls.length === 0) {
        state = trans({ kind: 'final_answer' })
        deps.emit({ type: 'finished' })
        return { context, newMessages }  // 正常结束
      }

      state = trans({ kind: 'tool_calls' })

      // 6. 串行执行工具
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!
        const isLast = i === calls.length - 1
        if (deps.checkCancelled()) { state = trans({ kind: 'cancel' }); throw new CancelledError() }

        const step = await executeOneTool(call, { ...deps, trans: (input) => { state = trans(input) } }, isLast, deps.reasoning)
        context.push(step.toolMessage)
        newMessages.push(step.toolMessage)
        state = trans(step.transitionInput)
      }
      // 回到 for(;;) 顶部，再问模型
    }
  } catch (e) {
    // 中断/错误：补全未配对的 tool_calls，返回部分结果
    patchUnpairedToolCalls(context)
    if (e instanceof CancelledError) return { context, newMessages, cancelled: true }
    return { context, newMessages, error: (e as Error).message }
  }
}
```

## 关键设计点

### 1. context 是拷贝

```ts
const context = [...deps.context]
```

loop 操作的是 context 的拷贝——push、压缩都在这个拷贝上。成功时返回 `result.context`，agent 赋值给 `this.context`。这样即使中途出错，`this.context` 不被污染。

### 2. newMessages 双写

每条 assistant/tool 消息同时 push 到 `context`（发给模型）和 `newMessages`（返回给 agent 同步到 history）。但 history 不受压缩影响——压缩只改 context，history 是完整原文。

```ts
// agent/src/core/agent.ts runTurn()
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

`adapter.chat(req, signal, emit)` 的第三个参数是流式回调——每收到一个 `text_delta` 或 `thought_delta` 就立即 emit 给 UI。UI 据此实时渲染流式文本。

推理模型的 `thought_done` 迁移在 `text_delta` 第一次到达时触发——因为推理模型先吐 reasoning（`thought_delta`），再吐正文（`text_delta`），第一次收到 `text_delta` 意味着 reasoning 结束。

## LoopDeps：依赖注入

loop 不直接 import adapter、permission、session——所有依赖通过 `LoopDeps` 注入：

```ts
interface LoopDeps {
  adapter: ProviderAdapter           // LLM 调用
  context: Message[]                  // 发给模型的消息
  tools: Tool[]                       // 可用工具
  permission: PermissionManager       // 权限管理
  signal: AbortSignal                 // 取消信号
  emit: (e) => void                   // 发 UI 事件
  requestPermission: (...) => ...     // 权限请求
  checkCancelled: () => boolean       // 取消检查
  trans: (input) => void              // 状态迁移
  summarize: (old, signal?) => ...    // 压缩摘要（agent 注入）
}
```

这让 loop 可独立测试——注入 fake adapter（脚本化返回），不联网跑。

## 打断保存策略总结

| 数据 | 打断时 | 理由 |
|---|---|---|
| user 消息 | ✅ 保存 | 完整意图 |
| 已完成 assistant + tool | ✅ 保存 | 有价值 |
| 未配对 tool_calls | ✅ 补 cancelled | API 要求配对 |
| 部分流式文本 | ❌ 不保存 | 半句话无价值 |
| 压缩结果（被中断） | ❌ 不保存 | 没完成 |
