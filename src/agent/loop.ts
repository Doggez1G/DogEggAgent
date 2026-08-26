import type { ProviderAdapter } from '../llm/types'
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision, State } from '../events/types'
import type { AgentToUiMessage } from '../events/agent-to-ui'
import { PermissionManager } from './permission'
import { truncate } from '../common/utils/truncate'
import { CancelledError } from '../common/errors'

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
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
}

// 核心循环：串行工具、权限暂停、取消三件套（AbortController 由 adapter 层 + 工具层处理）。
// 返回完整的历史消息（含 user/assistant/tool），供持久化与 resume 回放。
export async function runLoop(deps: LoopDeps): Promise<Message[]> {
  const messages: Message[] = []
  let state: State = deps.reasoning ? 'thinking' : 'responding'
  let iterations = 0

  for (;;) {
    if (deps.checkCancelled()) throw new CancelledError()
    if (iterations++ >= deps.maxIterations) throw new Error('达到 maxIterations 上限')

    const signal = new AbortController().signal

    const assistant = await deps.adapter.chat(
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
      signal,
      (e) => {
        if (e.type === 'text_delta') deps.emit({ type: 'text_delta', delta: e.text })
        else if (e.type === 'thought_delta') deps.emit({ type: 'thought_delta', delta: e.text })
      },
    )

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
    for (const call of calls) {
      if (deps.checkCancelled()) throw new CancelledError()

      const tool = deps.tools.find((t) => t.name === call.function.name)
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `未知工具 ${call.function.name}` })
        continue
      }

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
      const result = await tool.execute(args, { cwd: deps.cwd, signal })
      const content = 'content' in result ? truncate(result.content) : `ERROR: ${result.error}`
      deps.emit({ type: 'tool_end', id: call.id, name: tool.name, output: content, error: 'error' in result ? result.error : undefined })
      messages.push({ role: 'tool', tool_call_id: call.id, content })
      deps.emit({ type: 'state', from: 'executing', to: 'responding' })
    }

    state = 'responding'
  }
}