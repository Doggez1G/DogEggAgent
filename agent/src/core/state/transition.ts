import type { State } from '@dogegg/bridge'
import type { TransitionInput } from './events'

// 合法迁移来源表：每个 input kind 只能从特定状态触发。
// 不在表中的（input, from）组合返回 from（不变），防止逻辑错误导致非法状态序列。
// 这是对当前纯输入驱动迁移的防护——现有调用序列都在合法范围内，不会受影响。
const VALID_FROM: Record<TransitionInput['kind'], ReadonlySet<State>> = {
  submit: new Set(['idle', 'finished', 'cancelled', 'error']),
  thought_done: new Set(['thinking']),
  final_answer: new Set(['responding']),
  tool_calls: new Set(['responding', 'thinking']),
  tool_auto: new Set(['tool_calling']),
  tool_needs_permission: new Set(['tool_calling']),
  allow: new Set(['waiting_permission']),
  tool_done: new Set(['executing', 'waiting_permission']),
  reject: new Set(['executing', 'waiting_permission', 'tool_calling']),
  result_back: new Set(['executing']),
  compact_start: new Set(['thinking', 'responding', 'idle', 'tool_calling', 'executing', 'waiting_permission']),
  compact_done: new Set(['compacting']),
  cancel: new Set(['thinking', 'responding', 'tool_calling', 'waiting_permission', 'executing', 'compacting']),
  error: new Set(['thinking', 'responding', 'tool_calling', 'waiting_permission', 'executing', 'compacting']),
  reset: new Set(['finished', 'cancelled', 'error', 'idle', 'compacting']),
}

// 10 态状态机的纯函数迁移表。
//
// 关键规则：reject / result_back 后的「重新请求模型」与 submit 一样：
// 推理模型回到 thinking、普通模型回到 responding，故 reject/result_back 取 reasoning 决定下一态。
// tool_done 表示「本轮还有下一个工具要执行」，从 executing/waiting_permission 回到 tool_calling。
// compact_start/compact_done 让压缩期间有可见状态（compacting），UI 可感知。
//
// 防护：若 (input, 当前态) 不在 VALID_FROM 中，返回当前态（不迁移），防止非法状态序列。
export function transition(s: State, input: TransitionInput): State {
  // 检查当前态是否允许此迁移——非法组合不迁移（返回原态）。
  const allowed = VALID_FROM[input.kind]
  if (allowed && !allowed.has(s)) return s

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
    case 'compact_start': return 'compacting'
    case 'compact_done': return input.next
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}
