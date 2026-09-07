// llm 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export type { LlmStreamEvent, ChatRequest, ChatResult, LlmClient, LlmClientConn } from './types'
export { clientFor } from './client-for'
export { OpenAiClient } from './provider/openai'
export { createOpenAiStreamParser } from './provider/openai'
