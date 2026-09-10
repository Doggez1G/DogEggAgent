import type { Message } from '@dogegg/bridge'
import type { LlmStreamEvent, LlmUsage, ChatRequest, LlmClientConn } from '../..'
import { createOpenAiStreamParser } from './parser'
import { buildRequest } from './request'
import { HttpError, NetworkError, StreamTimeoutError } from './errors'

// 超时模型（两级，均不含总时长上限——持续出字节的流是健康的，生成长度由 maxOutput 决定）：
// 1. 连接超时 CONNECT_TIMEOUT_MS：fetch 发起 → 响应头返回（含 DNS/TLS/服务端处理首响）。
// 2. 空闲超时 IDLE_TIMEOUT_MS：相邻 chunk 的最大间隔（首个 chunk 前的 body 等待同样受它约束）。
// 两级超时统一抛 StreamTimeoutError（retry 层可重试）；用户取消走 AbortError，互不混淆。
const CONNECT_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 60_000

// 单次流式请求：fetch → 逐行读 SSE 流 → 喂 parser → 累积最终 message + reasoning。
// 不做重试（重试在 OpenAiClient 层）。HTTP 错误 / 流中断 / 超时 / 无最终消息均抛错。
// 错误类型分类（HttpError / NetworkError / StreamTimeoutError），供 retry 层判断可重试性。
export async function streamOnce(conn: LlmClientConn, req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<{ message: Message; reasoning?: string; usage?: LlmUsage }> {
  const { url, init } = buildRequest(req, conn)

  // 连接超时：独立 controller 承载——超时 abort 与用户 abort 需区分归因。
  const connectCtrl = new AbortController()
  let connectTimedOut = false
  const onUserAbort = () => connectCtrl.abort()
  signal.addEventListener('abort', onUserAbort, { once: true })
  const connectTimer = setTimeout(() => { connectTimedOut = true; connectCtrl.abort() }, CONNECT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: connectCtrl.signal })
  } catch (e) {
    clearTimeout(connectTimer)
    signal.removeEventListener('abort', onUserAbort)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError') // 用户取消
    if (connectTimedOut) throw new StreamTimeoutError('connect')        // 连接超时（可重试）
    throw new NetworkError(e)                                           // 网络错误（可重试）
  }
  clearTimeout(connectTimer)
  // 注意：onUserAbort 监听保留——body 阶段用户 abort 仍需中断（fetch body 绑定 connectCtrl.signal）。

  if (!res.ok || !res.body) {
    const retryAfter = res.headers.get('retry-after')
    throw new HttpError(
      res.status,
      `HTTP ${res.status}`,
      retryAfter ? parseRetryAfter(retryAfter) : undefined,
    )
  }

  // 超时归因：reader.cancel 会让后续 read 以 done「正常」结束——必须在循环外还原为超时错误
  // （可重试），否则长生成被掐断时会误报成「流未产生最终消息」。
  let timeout: StreamTimeoutError | null = null
  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalMessage: Message | null = null
  let finalReasoning: string | undefined
  let finalUsage: LlmUsage | undefined


  try {
    for (;;) {
      // 空闲超时：每次 read 最多等 IDLE_TIMEOUT_MS，超时则中止。
      const idleTimer = setTimeout(() => {
        timeout = new StreamTimeoutError('idle')
        reader.cancel(timeout)
      }, IDLE_TIMEOUT_MS)

      let done: boolean
      let value: Uint8Array | undefined
      try {
        const result = await reader.read()
        done = result.done
        value = result.value
      } catch (e) {
        // reader.read reject：可能是 cancel 导致的（超时/外部 abort），区分类型。
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (e instanceof StreamTimeoutError) throw e
        throw new NetworkError(e)
      } finally {
        clearTimeout(idleTimer)
      }

      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 以换行分隔，逐行喂 parser；行可能跨 chunk，用 buf 缓冲未完整的尾行。
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd()
        buf = buf.slice(nl + 1)
        for (const e of parser.feed(line)) {
          if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning; finalUsage = e.usage }
          else emit(e)
        }
      }
    }

    // 处理残余行：连接关闭时最后一批字节可能没有尾随换行。
    if (buf.trim()) {
      for (const e of parser.feed(buf.trim())) {
        if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning; finalUsage = e.usage }
        else emit(e)
      }
    }
  } finally {
    signal.removeEventListener('abort', onUserAbort)
  }

  if (!finalMessage) {
    // 超时触发的 cancel 会优雅结束流——归因还原成 StreamTimeoutError（retry 层可重试）。
    if (timeout) throw timeout
    throw new Error('流未产生最终消息')
  }
  return { message: finalMessage, reasoning: finalReasoning, usage: finalUsage }
}

// 解析 Retry-After header：支持秒数（"120"）和 HTTP-date 两种格式。
function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = new Date(value)
  const diff = date.getTime() - Date.now()
  if (Number.isFinite(diff) && diff > 0) return diff
  return undefined
}
