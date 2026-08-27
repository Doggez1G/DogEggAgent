import type { ProviderAdapter } from '../llm/types'
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision, State } from '../events/types'
import type { AgentToUiMessage } from '../events/agent-to-ui'
import { transition, type TransitionInput } from './state'
import { PermissionManager } from './permission'
import { estimateContextTokens, shouldCompact, splitForCompaction } from './context'
import { truncate } from '../common/utils/truncate'
import { CancelledError } from '../common/errors'

// 核心循环所需的外部依赖。emit 向上发 Agent 级事件，requestPermission 等待审批决议，checkCancelled 轮询取消。
export interface LoopDeps {
  adapter: ProviderAdapter
  providerBaseURL: string
  apiKey: string
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  tools: Tool[]
  history: Message[]
  systemPrompt: string
  windowTokens: number
  maxIterations: number
  permission: PermissionManager
  cwd: string
  shellProgram: string | undefined
  signal: AbortSignal
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
}

// 用同一 adapter 做一次「离线」总结，把最旧的历史压成一段中文摘要。
// 摘要是压缩后的替代，不含 tool_calls，故 tools 传空、maxOutput 控制长度。
// 导出以便手工 /compact 也能复用同一套总结逻辑。
export async function summarizeHistory(
  deps: { adapter: ProviderAdapter; providerBaseURL: string; apiKey: string; model: string },
  old: Message[],
): Promise<string> {
  const assistant = await deps.adapter.chat(
    {
      baseURL: deps.providerBaseURL,
      apiKey: deps.apiKey,
      model: deps.model,
      systemPrompt: '你是上下文压缩器。把这段对话压缩成一段简洁的中文摘要，保留关键事实、结论与未完成事项。',
      messages: old,
      tools: [],
      maxOutput: 1000,
      maxRetries: 1,
    },
    new AbortController().signal,
    () => {},
  )
  return typeof assistant.content === 'string' ? assistant.content : ''
}

// 核心 Agent Loop：问模型 → 有 tool_calls 就串行执行 → 结果回填 → 再问，直到无 tool_calls 或触发停止。
// 状态完全由 state.ts 的 transition() 纯函数驱动——这是 9 态状态机的落地处。
// 返回完整历史（user/assistant/tool），供会话持久化与 resume 回放。
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  // 从传入的历史开始（含用户刚提交的消息），在此之上累积 assistant/tool 消息并在最后返回完整历史。
  let messages: Message[] = [...deps.history]
  let state: State = 'idle'
  let iterations = 0
  const toolParams = deps.tools.map((t) => t.parameters)

  // 状态迁移的唯一出口：先经 transition() 算下一态，再 emit（Agent 侧据此同步其自身 state）。
  // 返回下一态，调用方 `state = trans(...)` 让 TS 看见主流程里的重赋值，避免窄化到 'idle'。
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

    // 上下文窗口管理：逼近上限时，把最旧历史压成摘要 + 保留最近 4 条原文。
    const used = estimateContextTokens(deps.systemPrompt, messages, toolParams)
    if (shouldCompact(used, deps.windowTokens)) {
      const { old, fresh } = splitForCompaction(messages)
      if (old.length > 0) {
        const summary = await summarizeHistory(deps, old)
        messages = [{ role: 'user', content: `[前文摘要]\n${summary}` }, ...fresh]
        deps.emit({ type: 'compaction', before_tokens: used, after_tokens: estimateContextTokens(deps.systemPrompt, messages, toolParams) })
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
          messages,
          tools: deps.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
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
      // 取消引发的 AbortError 应视为取消而非错误，统一转成 CancelledError 上抛。
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
    messages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: '' })

    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) {
      state = trans({ kind: 'final_answer' })
      deps.emit({ type: 'finished' })
      return messages
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

      const tool = deps.tools.find((t) => t.name === call.function.name)
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` })
        state = isLast ? trans({ kind: 'reject', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
        continue
      }

      // 工具参数：LLM 给的 arguments 是 JSON 字符串，先解析再用 zod schema 校验。
      let args: unknown
      try {
        args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: '参数校验失败' })
        state = isLast ? trans({ kind: 'reject', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
        continue
      }

      const verdict = deps.permission.classify(tool.name)
      if (verdict === 'reject') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
        state = isLast ? trans({ kind: 'reject', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
        continue
      }
      if (verdict === 'ask') {
        state = trans({ kind: 'tool_needs_permission' })
        const decision = await deps.requestPermission(tool.name, args)
        deps.permission.apply(tool.name, decision)
        if (decision === 'reject') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
          state = isLast ? trans({ kind: 'reject', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
          continue
        }
        state = trans({ kind: 'allow' })
        deps.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
        const result = await tool.execute(args, { cwd: deps.cwd, signal: deps.signal, shellProgram: deps.shellProgram })
        const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
        deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
        messages.push({ role: 'tool', tool_call_id: call.id, content })
        state = isLast ? trans({ kind: 'result_back', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
      } else {
        state = trans({ kind: 'tool_auto' })
        deps.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
        const result = await tool.execute(args, { cwd: deps.cwd, signal: deps.signal, shellProgram: deps.shellProgram })
        const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
        deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
        messages.push({ role: 'tool', tool_call_id: call.id, content })
        state = isLast ? trans({ kind: 'result_back', reasoning: deps.reasoning }) : trans({ kind: 'tool_done' })
      }
    }
  }
}