import type { State } from '@dogegg/bridge'

// 状态机迁移输入。每个 kind 对应一个触发迁移的事件。
export type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }
  | { kind: 'thought_done' }
  | { kind: 'final_answer' }
  | { kind: 'tool_calls' }
  | { kind: 'tool_auto' }
  | { kind: 'tool_needs_permission' }
  | { kind: 'allow' }
  | { kind: 'tool_done' }
  | { kind: 'reject'; reasoning: boolean }
  | { kind: 'result_back'; reasoning: boolean }
  | { kind: 'compact_start' } // 压缩开始 → compacting
  | { kind: 'compact_done'; next: State } // 压缩结束 → 回到指定态（loop 自动: thinking/responding；手动: idle）
  | { kind: 'cancel' }
  | { kind: 'error' }
  | { kind: 'reset' }
