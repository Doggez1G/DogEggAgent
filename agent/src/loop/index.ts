// loop 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { AgentLoop } from './agent-loop'
export { ToolExecutor } from './tool-executor'
export type { LoopServices, TurnInput, LoopResult } from './types'
