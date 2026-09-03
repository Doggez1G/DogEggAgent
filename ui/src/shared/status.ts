import type { State } from '@dogegg/bridge'

// 状态标签映射——TUI 和 WebUI 共用，消除三份重复的 STATUS_LABELS。
// 用 Record<string, string> 而非 Record<State, string>，因为组件的 status prop 类型是 string。
export const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  responding: 'Responding',
  tool_calling: 'Calling Tool',
  waiting_permission: 'Awaiting Permission',
  executing: 'Executing',
  finished: 'Finished',
  cancelled: 'Cancelled',
  error: 'Error',
  compacting: 'Compacting',
}

// 判断状态是否为"运行中"——TUI 和 WebUI 共用，消除两份重复的 isRunning 检查。
export function isStateRunning(state: State): boolean {
  return state !== 'idle' && state !== 'finished' && state !== 'cancelled' && state !== 'error'
}
