import type { Message, State } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { transition, type TransitionInput } from '../core/state'
import { estimateContextTokens, compactContext } from '../context'
import { toolSchemas } from '../tools'
import { executeOneTool } from './tool-calls'
import { CancelledError } from '../shared/errors'
import { newId } from '../shared/id'
import type { LoopDeps, LoopResult } from './types'

// 核心 Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 状态完全由 state.ts 的 transition() 纯函数驱动——这是 9 态状态机的落地处。
//
// R1：loop 只操作 context（发给模型的消息），不碰 history。
// 本轮新增的 assistant/tool 消息收集到 newMessages，供 core 同步 append 到 history。
// 压缩只改 context（丢旧消息换摘要），history 不受影响。
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const context = [...deps.context]
  const newMessages: Message[] = []
  let state: State = 'idle'
  let iterations = 0
  const toolParams = deps.tools.map((t) => t.parameters)

  // 状态迁移的唯一出口：先经 transition() 算下一态，再 emit（让 UI 据此同步）。
  const trans = (input: TransitionInput): State => {
    const next = transition(state, input)
    if (next !== state) deps.emit({ type: 'state', from: state, to: next })
    return next
  }

  // 每次「重新请求模型」进入 thinking（推理）或 responding（普通）——首次提交亦由此进入。
  state = trans({ kind: 'submit', reasoning: deps.reasoning })

  for (;;) {
    if (deps.checkCancelled()) {
      state = trans({ kind: 'cancel' })
      throw new CancelledError()
    }
    if (iterations++ >= deps.maxIterations) {
      state = trans({ kind: 'error' })
      throw new Error('达到 maxIterations 上限')
    }

    // 上下文窗口管理：逼近上限时压缩 context（只改 context，不动 history）。
    const used = estimateContextTokens(deps.systemPrompt, context, toolParams)
    if (used > deps.windowTokens * 0.8) {
      const result = await compactContext({
        context,
        systemPrompt: deps.systemPrompt,
        tools: toolParams,
        windowTokens: deps.windowTokens,
        summarize: deps.summarize,
      })
      if (result.compacted) {
        // 压缩改变了 context 数组内容——用新数组替换。newMessages 不受影响（它们是本轮新增的）。
        context.length = 0
        context.push(...result.context)
        deps.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after })
      }
    }

    // 用外部传入的 signal（由 Agent 持有，cancel 时 abort），使取消能真正中断在飞的 fetch 与工具。
    let assistant: Message
    try {
      assistant = await deps.adapter.chat(
        {
          baseURL: deps.providerBaseURL,
          apiKey: deps.apiKey,
          model: deps.model,
          systemPrompt: deps.systemPrompt,
          messages: context,
          tools: toolSchemas(),
          maxOutput: deps.maxOutput,
          maxRetries: deps.maxRetries,
        },
        deps.signal,
        (e) => {
          if (e.type === 'text_delta') {
            // 推理模型的 reasoning 阶段结束、开始吐正文：thinking → responding。
            if (state === 'thinking') state = trans({ kind: 'thought_done' })
            deps.emit({ type: 'text_delta', delta: e.text })
          } else if (e.type === 'thought_delta' && deps.reasoning) {
            deps.emit({ type: 'thought_delta', delta: e.text })
          }
        },
      )
    } catch (e) {
      // 取消引发的 AbortError 视为取消而非错误，统一转成 CancelledError 上抛。
      if ((e as Error).name === 'AbortError') {
        state = trans({ kind: 'cancel' })
        throw new CancelledError()
      }
      state = trans({ kind: 'error' })
      throw e
    }

    if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
    // 推理模型只返回 tool_calls 而无 text_delta 时，此处补上 thinking → responding 的收尾。
    if (state === 'thinking') state = trans({ kind: 'thought_done' })
    context.push(assistant)
    newMessages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: newId() })

    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) {
      state = trans({ kind: 'final_answer' })
      deps.emit({ type: 'finished' })
      return { context, newMessages }
    }

    state = trans({ kind: 'tool_calls' })

    // 串行执行本次响应的工具，逐个回填 tool 消息。每个工具处理完回到 tool_calling；
    // 最后一个处理完（执行或拒绝）才进入 result_back/reject → 重新请求模型。
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!
      const isLast = i === calls.length - 1
      if (deps.checkCancelled()) {
        state = trans({ kind: 'cancel' })
        throw new CancelledError()
      }

      const step = await executeOneTool(call, deps, isLast, deps.reasoning)
      context.push(step.toolMessage)
      newMessages.push(step.toolMessage)
      state = trans(step.transitionInput)
    }
  }
}
