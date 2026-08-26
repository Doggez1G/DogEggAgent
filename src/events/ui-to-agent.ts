import type { PermissionDecision } from './types'

// 前端 → 后端的消息契约。command 与 event 本质相同，只是方向相反，故统一为「消息」。
export type UiToAgentMessage =
  | { type: 'submit'; text: string }
  | { type: 'permission_decision'; id: string; decision: PermissionDecision }
  | { type: 'cancel' }
  | { type: 'new_session' }
  | { type: 'list_sessions' }
  | { type: 'resume_session'; id: string }
  | { type: 'config_request' }
  | { type: 'config_set'; path: string; value: unknown }
  | { type: 'config_add'; path: string; value: unknown }
  | { type: 'config_remove'; path: string; key: string; match: string }
  | { type: 'tools_request' }
  | { type: 'context_request' }
  | { type: 'system_request' }
  | { type: 'status_request' }
  | { type: 'log_request' }
  | { type: 'clear_history' }
  | { type: 'compact_request' }
  | { type: 'quit' }