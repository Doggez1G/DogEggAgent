import type { Message, State } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import { transition, type TransitionInput } from '../core'
import { estimateContextTokens, compactContext, enforceContextLimit } from '../context'
import { toolSchemas } from '../tools'
import { executeOneTool } from './tool-calls'
import { CancelledError } from '../shared'
import { newId } from '../shared'
import type { LoopDeps, LoopResult } from './types'

// 用 toolSchemas()（wrapped OpenAI 格式）而非 raw tool.parameters，使估算与实际请求一致。
const toolParams = toolSchemas()

// 核心Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 状态完全由 state.ts 的 transition() 纯函数驱动——这是 10 态状态机的落地处。
//
// R1：loop 只操作 context（发给模型的消息），不碰 history。
// 本轮新增的 assistant/tool 消息收集到 newMessages，供 core 同步 append 到 history。
// 压缩只改 context（丢旧消息换摘要），history 不受影响。
//
// 打断（cancel）：catch CancelledError 时返回部分结果（已 push 到 context/newMessages 的消息），
// 并补全未配对的 tool_calls（补 tool: cancelled 消息），保证 context 是完整的对话状态。
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const context = [...deps.context]
  const newMessages: Message[] = []
  let state: State = 'idle'
  let iterations = 0

  // 状态迁移的唯一出口：先经 transition() 算下一态，再 emit（让 UI 据此同步）。
  const trans = (input: TransitionInput): State => {
    const next = transition(state, input)
    if (next !== state) deps.emit({ type: 'state', from: state, to: next })
    return next
  }

  // 补全未配对的 tool_calls：扫描 msgs 找最后一条带 tool_calls 的 assistant 消息（不要求在数组尾部），
  // 检查其每个 tool_call_id 是否有配对的 tool 结果消息。缺的补一条 tool: cancelled 消息。
  // OpenAI API 要求 assistant 的每个 tool_call 必须有配对的 tool 消息，否则报 400。
  // 多工具批量调用时，tool 1 执行完、tool 2 被取消，尾部是 tool1_result（role:tool），
  // 旧版只查尾部会漏掉——必须向后扫描找最后一条 assistant。
  const patchUnpairedToolCalls = (msgs: Message[]): void => {
    // 向后扫描找最后一条带 tool_calls 的 assistant 消息。
    let lastAssistantIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) { lastAssistantIdx = i; break }
    }
    if (lastAssistantIdx < 0) return
    const assistant = msgs[lastAssistantIdx]!
    // 收集此 assistant 之后所有已配对的 tool_call_id。
    const paired = new Set<string>()
    for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
      const m = msgs[i]!
      if (m.role === 'tool') paired.add(m.tool_call_id)
    }
    // 为每个未配对的 tool_call 补 cancelled 消息。
    const toolCalls = assistant.role === 'assistant' ? (assistant.tool_calls ?? []) : []
    for (const tc of toolCalls) {
      if (!paired.has(tc.id)) {
        const cancelledMsg: Message = { role: 'tool', tool_call_id: tc.id, content: 'cancelled（用户打断了操作）' }
        msgs.push(cancelledMsg)
        newMessages.push(cancelledMsg)
      }
    }
  }

  // 思考内容收集——每个 assistant 回复的 reasoning，不进 history/context，单独持久化。
  const thinking: { text: string }[] = []

  try {
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
      // 压缩期间 emit state → compacting 让 UI 可感知，完成后回到 thinking/responding（继续本轮请求）。
      // 压缩失败时降级——跳过压缩继续用未压缩 context 请求模型，不 abort 整个 turn。
      const used = estimateContextTokens(deps.systemPrompt, context, toolParams)
      if (used > deps.windowTokens * 0.8) {
        state = trans({ kind: 'compact_start' })
        try {
          const result = await compactContext({
            context,
            systemPrompt: deps.systemPrompt,
            tools: toolParams,
            windowTokens: deps.windowTokens,
            summarize: deps.summarize,
            signal: deps.signal,
          })
          if (result.compacted) {
            context.length = 0
            context.push(...result.context)
            deps.emit({ type: 'compaction', before_tokens: result.before, after_tokens: result.after, source: 'auto' })
          }
        } catch {
          // 压缩失败（如 LLM 调用出错）——降级继续，模型仍可用未压缩 context 回答。
        }
        state = trans({ kind: 'compact_done', next: deps.reasoning ? 'thinking' : 'responding' })

        // 硬上限兜底：压缩后仍超 80%（单条消息极大或压缩失败降级），从头部丢弃最旧消息。
        // 被丢弃的消息在 history 中仍保留，只是不再发给模型。
        const enforced = enforceContextLimit({
          systemPrompt: deps.systemPrompt,
          context,
          tools: toolParams,
          windowTokens: deps.windowTokens,
        })
        if (enforced.dropped > 0) {
          context.length = 0
          context.push(...enforced.context)
        }
      }

      // 用外部传入的 signal（由 Agent 持有，cancel 时 abort），使取消能真正中断在飞的 fetch 与工具。
      let result
      try {
        result = await deps.adapter.chat(
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

      const assistant = result.message
      // 每轮 LLM 调用都 push 一个 thinking 条目——保持与 assistant 消息数一一对应。
      // 只在 deps.reasoning（当前模型开启了思考）时才记录实际 reasoning 内容；
      // 关闭思考时即使模型返回了 reasoning 也存空字符串——不记录、不显示。
      // 空字符串条目在 rebuildBlocksFromHistory 中被跳过（不显示思考气泡）。
      thinking.push({ text: deps.reasoning ? (result.reasoning ?? '') : '' })

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
        return { context, newMessages, thinking }
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

        const step = await executeOneTool(call, { ...deps, trans: (input) => { state = trans(input) } }, isLast, deps.reasoning)
        context.push(step.toolMessage)
        newMessages.push(step.toolMessage)
        state = trans(step.transitionInput)
      }
    }
  } catch (e) {
    // 打断或错误：补全未配对的 tool_calls，返回部分结果（含已完成的 assistant/tool 消息）。
    // 之前错误路径直接 throw 导致 newMessages 丢失——现在统一返回部分结果，agent 保存已完成的工具执行。
    patchUnpairedToolCalls(context)
    if (e instanceof CancelledError) {
      return { context, newMessages, thinking, cancelled: true }
    }
    return { context, newMessages, thinking, error: (e as Error).message }
  }
}
