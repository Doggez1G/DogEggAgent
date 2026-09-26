import type { Message } from '@dogegg/bridge'
import type { PermissionResolution } from './pending'
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
  requestPermission: (tool: string, input: unknown) => Promise<PermissionResolution>
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
  /**
   * 轮次进行中回调（可选）：每条 assistant 消息 push 后与每个工具 step 完成后触发——
   * 接收方据此实现轮中检查点落盘 / 中途标题触发 / 实时 token 估算。
   * ⚠️ 传的是 loop 内部工作数组的【引用】（不拷贝——热路径上拷贝整个 context 不可接受），
   * 接收方只读，不得改写；数组内容会在后续迭代继续演化。usage 为轮内已累计的真实用量。
   *
   * partial / runningTool（P2-23 运行现场）随行快照：partial 是此刻流式中的 assistant 文本
   * （assistant 定稿即清零），runningTool 是进行中的工具（tool_start 起、tool_end 止）。
   * ⚠️ 两者只在 onProgress 触发时刻有效且恒为「刚收口」的值（本回调不发生在长工具执行中 /
   * 流式生成中）——需要【重发时刻】的最新现场（如 busy 期快照重发恢复 UI），应直读
   * AgentLoop.getLive()（turn-runner 的 getLiveTurn 已做此覆盖），勿依赖本字段的时效性。
   */
  onProgress?: (snap: {
    context: Message[]
    newMessages: Message[]
    thinking: { text: string }[]
    usage: { promptTokens: number; completionTokens: number }
    compactions: number
    /** 流式中的 assistant 文本（assistant 定稿即清零；空串 = 此刻无未定稿的流式内容）。 */
    partial?: string
    /** 进行中的工具（tool_start 起、tool_end 止；缺省 = 此刻无工具在执行）。 */
    runningTool?: { id: string; name: string; input: unknown }
  }) => void
}

// loop 返回值：压缩后的 context + 本轮新增的 assistant/tool 消息。
// newMessages 供 conversation 同步 append 到 history（R1：history 单调增长、永不被压缩影响）。
// thinking 供 session 持久化（resume 后恢复思考块显示），不进 history/context。
export interface LoopResult {
  context: Message[]
  newMessages: Message[]
  /** 本轮的思考内容（assistant 推理文本），按顺序排列，不进 history/context。 */
  thinking: { text: string }[]
  /** 本轮真实用量（API 返回，轮内多次调用累加）——写入会话累计并进 lastTurn/状态展示。 */
  usage?: { promptTokens: number; completionTokens: number }
  /** 本轮发生的自动压缩次数（供会话统计与 /context 仪表盘）。 */
  compactions?: number
  /** 是否被用户取消（Ctrl+C / cancel）。true 时 context 可能含未完成的 tool_calls。 */
  cancelled?: boolean
  /** 错误信息（maxIterations / API 失败等）。非空时 context 含已完成的 assistant/tool 消息。 */
  error?: string
}
