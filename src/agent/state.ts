import type { State } from '../events/types'

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

// 9 态状态机的纯函数迁移。拒绝回填 / 结果回填后的「重新请求模型」与 submit 一样，
// 推理模型回到 thinking、普通模型回到 responding，故 reject/result_back 同样取 reasoning 决定下一态。
// tool_done 表示「本轮还有下一个工具要执行」，从 executing/waiting_permission 回到 tool_calling。
export function transition(_s: State, input: TransitionInput): State {
  switch (input.kind) {
    case 'submit': return input.reasoning ? 'thinking' : 'responding'
    case 'thought_done': return 'responding'
    case 'final_answer': return 'finished'
    case 'tool_calls': return 'tool_calling'
    case 'tool_auto':
    case 'allow': return 'executing'
    case 'tool_needs_permission': return 'waiting_permission'
    case 'tool_done': return 'tool_calling'
    case 'reject': return input.reasoning ? 'thinking' : 'responding'
    case 'result_back': return input.reasoning ? 'thinking' : 'responding'
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}