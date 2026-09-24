import type { LlmClient, LlmStreamEvent, ChatRequest, ChatResult, LlmClientConn } from '../..'
import { streamOnce } from './stream'
import { withRetry } from './retry'

// OpenAI 兼容客户端：原生 fetch + 手写 SSE，返回组装好的 assistant 消息 + reasoning。
// 连接参数（baseURL/apiKey）归实例所有——同一 provider 的多个模型复用同一实例。
// 对网络/HTTP 错误重试（maxRetries + 1 次），AbortError 不重试。
export class OpenAiClient implements LlmClient {
  constructor(private readonly conn: LlmClientConn) {}

  async chat(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<ChatResult> {
    // 立法：请求层重试从零重发增量——第 2 次及以后的尝试开始前先发一次 stream_reset，
    // 让 UI 清空上次尝试残留的 partial（第 1 次不发，无可清之残文）。
    // 否则第 2 次尝试的 delta 追加在第 1 次残文后，展示与持久化分叉。
    let attempt = 0
    return withRetry(
      req.maxRetries + 1,
      () => {
        if (attempt++ > 0) emit({ type: 'stream_reset' })
        return streamOnce(this.conn, req, signal, emit)
      },
      signal,
    )
  }
}
