// context 门面：汇总对外 API。纯 re-export，不含实现逻辑（见 §1 约束 3）。
// 只管 Context（发给模型的消息），不管 History（显示用的完整历史）——两者分离，见需求 §3.1。
export { loadSystemPrompt, BUILTIN_PROMPT } from './prompt'
export { truncate, TOOL_RESULT_CAP } from './message'
export { estimateTokens, estimateContextTokens } from './token'
export { shouldCompact, splitForCompaction, summarizeHistory, compactContext, enforceContextLimit, type CompactResult } from './compact'
