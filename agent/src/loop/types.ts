import type { ProviderAdapter } from '../llm/types'
import type { Tool } from '../tools/types'
import type { Message, PermissionDecision, State } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { PermissionManager } from '../permission'

// 核心循环所需的外部依赖。由 core/agent.ts 在 submit 时组装传入。
// - emit：向上发 Agent 级事件（供 UI 渲染）
// - requestPermission：等待用户审批决议（返回 Promise，在 waiting_permission 态挂起）
// - checkCancelled：轮询取消标志（loop 在每次迭代/工具间检查）
// - summarize：压缩回调（调 LLM 把旧消息压摘要），由 core 注入以避免 loop 直接依赖 llm adapter
export interface LoopDeps {
  adapter: ProviderAdapter
  providerBaseURL: string
  apiKey: string
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  tools: Tool[]
  /** 发给模型的消息列表（会被压缩）。loop 原地修改它并返回。History 由 core 持有，不在此。 */
  context: Message[]
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
  /** 状态迁移回调（让 executeOneTool 能发 waiting_permission/executing 迁移）。 */
  trans: (input: import('../core/state').TransitionInput) => void
  /** 压缩时调 LLM 做摘要（core 注入，避免 loop 直接依赖 llm）。 */
  summarize: (old: Message[], signal?: AbortSignal) => Promise<string>
}

// loop 返回值：压缩后的 context + 本轮新增的 assistant/tool 消息。
// newMessages 供 core 同步 append 到 history（R1：history 单调增长、永不被压缩影响）。
export interface LoopResult {
  context: Message[]
  newMessages: Message[]
  /** 是否被用户取消（Ctrl+C / cancel）。true 时 context 可能含未完成的 tool_calls。 */
  cancelled?: boolean
  /** 错误信息（maxIterations / API 失败等）。非空时 context 含已完成的 assistant/tool 消息。 */
  error?: string
}
