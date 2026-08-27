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
  | { kind: 'cancel' }
  | { kind: 'error' }
  | { kind: 'reset' }
