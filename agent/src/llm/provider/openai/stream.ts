import type { Message } from '@dogegg/bridge'
import type { LlmStreamEvent, ChatRequest, LlmClientConn } from '../..'
import { createOpenAiStreamParser } from './parser'
import { buildRequest } from './request'
import { HttpError, NetworkError, StreamTimeoutError } from './errors'

// 流式超时常量：绝对超时 600s（推理模型长思考 + 长回答可轻松超过旧值 120s——那会掐断正常生成），
// 空闲超时 60s（连续 60s 无任何字节才算失联；部分兼容端点对推理阶段不流式，静默数分钟是正常的）。
const ABSOLUTE_TIMEOUT_MS = 600_000
const IDLE_TIMEOUT_MS = 60_000

// 单次流式请求：fetch → 逐行读 SSE 流 → 喂 parser → 累积最终 message + reasoning。
// 不做重试（重试在 OpenAiClient 层）。HTTP 错误 / 流中断 / 超时 / 无最终消息均抛错。
// 错误类型分类（HttpError / NetworkError / StreamTimeoutError），供 retry 层判断可重试性。
export async function streamOnce(conn: LlmClientConn, req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<{ message: Message; reasoning?: string }> {
  const { url, init } = buildRequest(req, conn)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    // fetch reject：网络错误（DNS 失败、连接拒绝、ECONNRESET 等），可重试。
    if ((e as Error).name === 'AbortError') throw e
    throw new NetworkError(e)
  }

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

  // 绝对超时计时器——从请求开始算，超过 ABSOLUTE_TIMEOUT_MS 则中止。
  const absoluteTimer = setTimeout(() => {
    timeout = new StreamTimeoutError('absolute')
    reader.cancel(timeout).catch(() => {})
  }, ABSOLUTE_TIMEOUT_MS)

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
          if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning }
          else emit(e)
        }
      }
    }

    // 处理残余行：连接关闭时最后一批字节可能没有尾随换行。
    if (buf.trim()) {
      for (const e of parser.feed(buf.trim())) {
        if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning }
        else emit(e)
      }
    }
  } finally {
    clearTimeout(absoluteTimer)
  }

  if (!finalMessage) {
    // 超时触发的 cancel 会优雅结束流——归因还原成 StreamTimeoutError（retry 层可重试）。
    if (timeout) throw timeout
    throw new Error('流未产生最终消息')
  }
  return { message: finalMessage, reasoning: finalReasoning }
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
