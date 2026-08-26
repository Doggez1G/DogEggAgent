import type { ProviderAdapter } from '../llm/types'
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision, State } from '../events/types'
import type { AgentToUiMessage } from '../events/agent-to-ui'
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
  systemPrompt: string
  windowTokens: number
  maxIterations: number
  permission: PermissionManager
  cwd: string
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
// 返回完整历史（user/assistant/tool），供会话持久化与 resume 回放。
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  let messages: Message[] = []
  let state: State = deps.reasoning ? 'thinking' : 'responding'
  let iterations = 0
  const toolParams = deps.tools.map((t) => t.parameters)

  for (;;) {
    if (deps.checkCancelled()) throw new CancelledError()
    if (iterations++ >= deps.maxIterations) throw new Error('达到 maxIterations 上限')

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
          if (e.type === 'text_delta') deps.emit({ type: 'text_delta', delta: e.text })
          else if (e.type === 'thought_delta') deps.emit({ type: 'thought_delta', delta: e.text })
        },
      )
    } catch (e) {
      // 取消引发的 AbortError 应视为取消而非错误，统一转成 CancelledError 上抛。
      if ((e as Error).name === 'AbortError') throw new CancelledError()
      throw e
    }

    if (assistant.role !== 'assistant') throw new Error('模型未返回 assistant 消息')
    messages.push(assistant)
    deps.emit({ type: 'message', role: 'assistant', id: '' })

    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) {
      deps.emit({ type: 'state', from: state, to: 'finished' })
      deps.emit({ type: 'finished' })
      return messages
    }

    deps.emit({ type: 'state', from: state, to: 'tool_calling' })
    // 串行执行本次响应的工具，逐个回填 tool 消息。
    for (const call of calls) {
      if (deps.checkCancelled()) throw new CancelledError()

      const tool = deps.tools.find((t) => t.name === call.function.name)
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` })
        continue
      }

      // 工具参数：LLM 给的 arguments 是 JSON 字符串，先解析再用 zod schema 校验。
      let args: unknown
      try {
        args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: '参数校验失败' })
        continue
      }

      const verdict = deps.permission.classify(tool.name)
      if (verdict === 'reject') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
        continue
      }
      if (verdict === 'ask') {
        deps.emit({ type: 'state', from: 'tool_calling', to: 'waiting_permission' })
        const decision = await deps.requestPermission(tool.name, args)
        deps.permission.apply(tool.name, decision)
        if (decision === 'reject') {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'denied' })
          continue
        }
      }

      deps.emit({ type: 'state', from: 'waiting_permission', to: 'executing' })
      deps.emit({ type: 'tool_start', id: call.id, name: tool.name, input: args })
      const result = await tool.execute(args, { cwd: deps.cwd, signal: deps.signal })
      const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
      deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
      messages.push({ role: 'tool', tool_call_id: call.id, content })
      deps.emit({ type: 'state', from: 'executing', to: 'responding' })
    }

    state = 'responding'
  }
}