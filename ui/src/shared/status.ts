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

// 工具参数生成期间（tool_pending → tool_start）的提示文案——TUI/WebUI 必须同一出处，
// 两端各写一份迟早漂移（此前的「生成调用参数」vs「准备调用」即教训）。
// 语义上该阶段是在流式生成调用参数，但用户视角统一表述为「正在调用」；工具名缺失时退化为泛化文案。
export function pendingToolLabel(name: string): string {
  return name ? `正在调用 ${name}…` : '正在调用工具…'
}
