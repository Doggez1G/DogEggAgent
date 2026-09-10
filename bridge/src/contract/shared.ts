// 后端与前端共享的核心类型。此文件是纯类型，无任何运行时逻辑，不依赖其它域。

// 上下文压缩阈值——Context 已用 token 超过窗口的此比例时触发压缩。
// 后端（trigger.ts, enforce.ts, agent-loop）和前端（info-panel 进度条过载判断）共用此常量。
// 【立法】这是跨端显示策略常量：阈值决定 UI 变色与后端触发，必须一致，刻意放契约防两端漂移。
export const COMPACTION_THRESHOLD = 0.8

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

// allow_always_scoped：对此范围不再询问（范围由 agent 推导并随 permission_request.alwaysScope 下发，
// 见 ADR-0010 与 2026-09-09-permission-promotion-design.md）。
export type PermissionDecision = 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject'

// 会话内提升的按工具分组形态（/permissions 展示、会话文件 sessionPermissions 同构）。
// patterns 空 = 整工具提升；非空 = 范围模式列表。
export interface ToolPermission {
  tool: string
  patterns: string[]
}

// context token 分段估算（/context 仪表盘）：system 提示词 / 用户消息 / 助手消息 / 工具输出 / 工具 schema。
export interface ContextBreakdown {
  system: number
  user: number
  assistant: number
  tool: number
  tools: number
}

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