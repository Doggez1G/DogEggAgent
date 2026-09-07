import type { LlmClient, LlmStreamEvent, ChatRequest, ChatResult, LlmClientConn } from '../..'
import { streamOnce } from './stream'
import { withRetry } from './retry'

// OpenAI 兼容客户端：原生 fetch + 手写 SSE，返回组装好的 assistant 消息 + reasoning。
// 连接参数（baseURL/apiKey）归实例所有——同一 provider 的多个模型复用同一实例。
// 对网络/HTTP 错误重试（maxRetries + 1 次），AbortError 不重试。
export class OpenAiClient implements LlmClient {
  constructor(private readonly conn: LlmClientConn) {}

  async chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult> {
    return withRetry(req.maxRetries + 1, () => streamOnce(this.conn, req, signal, emit), signal)
  }
}
