import type { State, Message } from './shared'
import type { Config } from './config'

// 后端 → 前端的消息契约。仅类型；方向单一，保证后端/前端解耦且互不 import 业务实现。
// 将来接 SSE 时，序列化/反序列化的正是这一套类型，故 error 用可序列化形状而非 Error。
export type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'tool'; id: string } // id 为真值（非空串），与 tool_start 的 id 同源，供 UI 定位/折叠/滚动
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; error?: string } // 拒绝/失败工具也发 tool_end（error 标明原因），不再静默塞消息
  | { type: 'permission_request'; id: string; tool: string; input: unknown }
  | { type: 'session_ready'; id: string; messages: Message[] }
  | { type: 'session_list'; sessions: { id: string; updatedAt: string; preview: string }[] }
  | { type: 'config_state'; config: Config }
  | { type: 'config_updated'; config: Config }
  | { type: 'tools_list'; tools: { name: string; description: string }[] }
  | { type: 'context_state'; estimatedTokens: number; windowTokens: number; percent: number }
  | { type: 'system_state'; path: string; content: string }
  | { type: 'status_state'; sessionId: string; provider: string; model: string; cwd: string; state: State; estimatedTokens: number; windowTokens: number }
  | { type: 'log_state'; path: string; tail: string }
  | { type: 'history_cleared' }
  | { type: 'notice'; text: string }
  | { type: 'compaction'; before_tokens: number; after_tokens: number; source: 'manual' | 'auto' } // source 区分手动/自动，UI 据此决定弹 overlay 还是插提示块
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: { message: string; name?: string } } // 可序列化：JSON.stringify(Error) 会丢 stack/name，进程内 Port 与将来 SSE 需同构