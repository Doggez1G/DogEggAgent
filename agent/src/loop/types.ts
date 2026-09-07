import type { Message, PermissionDecision } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { LlmClient } from '../llm'
import type { ToolRegistry } from '../tools'
import type { PermissionManager } from '../permission'

// AgentLoop 构造期服务：跨轮次稳定的协作组件（由 core/agent.ts 组装注入）。
// - emit：向上发 Agent 级事件（供 UI 渲染）
// - requestPermission：等待用户审批决议（返回 Promise，在 waiting_permission 态挂起）
// - checkCancelled：轮询取消标志（loop 在每次迭代/工具间检查）
// - summarize：压缩回调（调 LLM 把旧消息压摘要），由 core 注入以避免 loop 直接依赖 llm client
export interface LoopServices {
  registry: ToolRegistry
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
  summarize: (old: Message[], signal?: AbortSignal) => Promise<string>
}

// 单轮参数：provider 连接与工作集。每轮从 config/cwd 解析——config 编辑（换 provider/model、
// 改 maxIterations、重建 PermissionManager）只影响下一次 run，无需重建 AgentLoop。
export interface TurnInput {
  client: LlmClient
  model: string
  maxOutput: number
  maxRetries: number
  reasoning: boolean
  systemPrompt: string
  windowTokens: number
  /** 发给模型的消息列表（会被压缩）。loop 原地修改它并返回。History 由 core 持有，不在此。 */
  context: Message[]
  permission: PermissionManager
  maxIterations: number
  cwd: string
  shellProgram: string | undefined
  signal: AbortSignal
}

// loop 返回值：压缩后的 context + 本轮新增的 assistant/tool 消息。
// newMessages 供 core 同步 append 到 history（R1：history 单调增长、永不被压缩影响）。
// thinking 供 core 持久化到 session（resume 后恢复思考块显示），不进 history/context。
export interface LoopResult {
  context: Message[]
  newMessages: Message[]
  /** 本轮的思考内容（assistant 推理文本），按顺序排列，不进 history/context。 */
  thinking: { text: string }[]
  /** 是否被用户取消（Ctrl+C / cancel）。true 时 context 可能含未完成的 tool_calls。 */
  cancelled?: boolean
  /** 错误信息（maxIterations / API 失败等）。非空时 context 含已完成的 assistant/tool 消息。 */
  error?: string
}
