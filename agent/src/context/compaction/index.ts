// 压缩策略子域出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// 纯策略（无 LLM 接线）：何时压（trigger）、怎么切（split）；编排机制在 turn/compactor。
export { shouldCompact } from './trigger'
export { splitForCompaction } from './split'
