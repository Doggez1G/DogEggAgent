// loop 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// summarizeHistory 已归 context/compact，不在此（旧代码 loop/summarize.ts 已删）。
export { runLoop } from './run'
export { executeOneTool } from './tool-calls'
export type { LoopDeps, LoopResult } from './types'
