import type { Message, PermissionDecision } from '@dogegg/bridge'
import type { AgentToUiMessage } from '@dogegg/bridge'
import type { LlmClient } from '../llm'
import type { ToolRegistry } from '../tools'
import type { PermissionManager } from '../permission'
import type { StateMachine } from './state'
import type { Compactor } from './compactor'

// AgentLoop 构造期服务：跨轮次稳定的协作组件（由 agent.ts 组装注入）。
// - machine：全项目唯一状态机（ctx 持有，loop 在轮内 fire）
// - compactor：压缩编排单例（summarize 回调已闭合在构造处）
// - emit：向上发 Agent 级事件（供 UI 渲染）
// - requestPermission：等待用户审批决议（返回 Promise，在 waiting_permission 态挂起）——
//   这也是未来 SDK 的策略注入点（无头使用时可注入程序化决议）
// - checkCancelled：轮询取消标志（loop 在每次迭代/工具间检查）
export interface LoopServices {
  registry: ToolRegistry
  machine: StateMachine
  compactor: Compactor
  emit: (e: AgentToUiMessage) => void
  requestPermission: (tool: string, input: unknown) => Promise<PermissionDecision>
  checkCancelled: () => boolean
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
  /** 发给模型的消息列表（会被压缩）。loop 原地修改它并返回。History 由 session 持有，不在此。 */
  context: Message[]
  permission: PermissionManager
  maxIterations: number
  cwd: string
  shellProgram: string | undefined
  signal: AbortSignal
}

// loop 返回值：压缩后的 context + 本轮新增的 assistant/tool 消息。
// newMessages 供 conversation 同步 append 到 history（R1：history 单调增长、永不被压缩影响）。
// thinking 供 session 持久化（resume 后恢复思考块显示），不进 history/context。
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
