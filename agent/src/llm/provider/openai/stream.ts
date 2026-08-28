import type { Message } from '@dogegg/bridge'
import type { LlmStreamEvent, ChatRequest } from '../../types'
import { createOpenAiStreamParser } from '../../streaming/openai'
import { buildRequest } from './request'

// 单次流式请求：fetch → 逐行读 SSE 流 → 喂 parser → 累积最终 message。
// 不做重试（重试在 adapter 层）。HTTP 错误 / 流中断 / 无最终消息均抛错。
export async function streamOnce(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message> {
  const { url, init } = buildRequest(req)
  const res = await fetch(url, { ...init, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalMessage: Message | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE 以换行分隔，逐行喂 parser；行可能跨 chunk，用 buf 缓冲未完整的尾行。
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      for (const e of parser.feed(line)) {
        if (e.type === 'done') finalMessage = e.message
        else emit(e)
      }
    }
  }
  // 处理残余行：连接关闭时最后一批字节可能没有尾随换行。
  if (buf.trim()) {
    for (const e of parser.feed(buf.trim())) {
      if (e.type === 'done') finalMessage = e.message
      else emit(e)
    }
  }
  if (!finalMessage) throw new Error('流未产生最终消息')
  return finalMessage
}
