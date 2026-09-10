// context 域出口：模型输入的纯策略与组装。纯 re-export，不含实现逻辑（见 §1 约束 3）。
// 只管 Context（发给模型的消息），不管 History（显示用的完整历史）——两者分离，见需求 §3.1。
// 压缩的「机制/编排」在 turn/compactor（要接线 LLM 与事件），此处只保留「策略」。
export { ContextAssembler } from './assembler'
export { truncate, TOOL_RESULT_CAP } from './truncate'
export { estimateTokens, estimateContextTokens, breakdownContextTokens } from './token'
export { shouldCompact } from './compaction'
