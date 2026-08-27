// 后端与前端共享的核心类型。此文件是纯类型，无任何运行时逻辑，不依赖其它域。

export type State =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'tool_calling'
  | 'waiting_permission'
  | 'executing'
  | 'finished'
  | 'cancelled'
  | 'error'
  | 'compacting'

export type PermissionDecision = 'allow_once' | 'allow_always' | 'reject'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// OpenAI 线格式：持久化历史 / 恢复会话时可直接喂回模型，不丢失 tool_calls 关联。
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }