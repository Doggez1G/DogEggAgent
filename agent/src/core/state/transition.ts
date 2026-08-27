import type { State } from '@dogegg/bridge'
import type { TransitionInput } from './events'

// 10 态状态机的纯函数迁移表。当前态 _s 未参与判断——迁移完全由输入决定（输入驱动）。
//
// 关键规则：reject / result_back 后的「重新请求模型」与 submit 一样：
// 推理模型回到 thinking、普通模型回到 responding，故 reject/result_back 取 reasoning 决定下一态。
// tool_done 表示「本轮还有下一个工具要执行」，从 executing/waiting_permission 回到 tool_calling。
// compact_start/compact_done 让压缩期间有可见状态（compacting），UI 可感知。
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
    case 'compact_start': return 'compacting'
    case 'compact_done': return input.next
    case 'cancel': return 'cancelled'
    case 'error': return 'error'
    case 'reset': return 'idle'
  }
}
