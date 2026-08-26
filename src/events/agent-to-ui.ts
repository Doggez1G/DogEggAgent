import type { State, Message } from './types'
import type { Config } from '../config/schema'

// 后端 → 前端的消息契约。仅类型；方向单一，保证后端/前端解耦且互不 import 业务实现。
export type AgentToUiMessage =
  | { type: 'state'; from: State; to: State }
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'tool'; id: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: string; error?: string }
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
  | { type: 'compaction'; before_tokens: number; after_tokens: number }
  | { type: 'finished'; usage?: unknown }
  | { type: 'error'; error: Error }