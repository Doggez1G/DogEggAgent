import type { ProviderAdapter, LlmStreamEvent, ChatRequest, ChatResult } from '../..'
import { streamOnce } from './stream'
import { withRetry } from './retry'

// OpenAI 兼容 adapter：原生 fetch + 手写 SSE，返回组装好的 assistant 消息 + reasoning。
// 对网络/HTTP 错误重试（maxRetries + 1 次），AbortError 不重试。
export function openAiAdapter(): ProviderAdapter {
  return {
    async chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult> {
      return withRetry(req.maxRetries + 1, () => streamOnce(req, signal, emit), signal)
    },
  }
}
