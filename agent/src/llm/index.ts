// llm 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export type { LlmStreamEvent, ChatRequest, ChatResult, ProviderAdapter } from './types'
export { adapterFor } from './adapter-for'
export { openAiAdapter } from './provider/openai'
export { createOpenAiStreamParser } from './streaming/openai'
