import type { State } from '@dogegg/bridge'

// 状态标签映射——TUI 和 WebUI 共用，消除三份重复的 STATUS_LABELS。
// 用 Record<string, string> 而非 Record<State, string>，因为组件的 status prop 类型是 string。
//
// 立法（运行中状态显示正确性，2026-09-24）：
// 1. 文案必须「自解释」——executing 写「正在执行工具」而非泛化的「执行中」，让用户一眼区分
//    「模型在思考」（thinking）与「工具在跑」（executing），此前两端在工具执行期间被误读为
//    thinking 的教训即源于此。
// 2. tool_calling 与 executing 是两个阶段：前者是模型还在流式生成调用参数，后者是工具已开跑，
//    文案必须能区分（「正在生成工具调用」vs「正在执行工具」）。
// 3. 统一中文——TUI 状态栏本是中文，WebUI 混用英文导致同一状态两端表述漂移；标签是给用户看
//    的短文案（非代码标识符），跟随 TUI 取中文，技术术语保留英文的原则不适用于纯 UI 文案。
export const STATUS_LABELS: Record<string, string> = {
  idle: '就绪',
  thinking: '思考中',
  responding: '回复中',
  tool_calling: '正在生成工具调用',
  waiting_permission: '等待审批',
  executing: '正在执行工具',
  finished: '已完成',
  cancelled: '已取消',
  error: '出错',
  compacting: '压缩上下文',
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
