import type { State } from '../events/types'

export type TransitionInput =
  | { kind: 'submit'; reasoning: boolean }
  | { kind: 'thought_done' }
  | { kind: 'final_answer' }
  | { kind: 'tool_calls' }
  | { kind: 'tool_auto' }
  | { kind: 'tool_needs_permission' }
  | { kind: 'allow' }
  | { kind: 'reject' }
  | { kind: 'result_back' }
  | { kind: 'cancel' }
  | { kind: 'error' }
  | { kind: 'reset' }

// 9 态状态机的纯函数迁移。当前态多数迁移不依赖之前状态，但保留入参以便未来扩展与可测试性。
export function transition(_s: State, input: TransitionInput): State {
  switch (input.kind) {
    case 'submit': return input.reasoning ? 'thinking' : 'responding'
    case 'thought_done': return 'responding'
    case 'final_answer': return 'finished'
    case 'tool_calls': return 'tool_calling'
    case 'tool_auto':
    case 'allow': return 'executing'
    case 'tool_needs_permission': return 'waiting_permission'
    case 'reject':
    case 'result_back': return 'responding'
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}