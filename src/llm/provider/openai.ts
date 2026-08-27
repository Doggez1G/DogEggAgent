import type { ProviderAdapter, LlmStreamEvent, ChatRequest } from '../types'
import type { Message } from '@dogegg/bridge'
import type { ProviderConfig } from '@dogegg/bridge'
import { createOpenAiStreamParser } from '../streaming/openai'

// OpenAI 兼容 adapter：原生 fetch + 手写 SSE，返回组装好的 assistant 消息，并对网络/HTTP 错误重试。
export function openAiAdapter(): ProviderAdapter {
  async function once(req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<Message> {
    const url = `${req.baseURL.replace(/\/+$/, '')}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
        tools: req.tools,
        max_tokens: req.maxOutput,
      }),
    })
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
    if (!finalMessage) throw new Error('流未产生最终消息')
    return finalMessage
  }

  return {
    async chat(req, signal, emit) {
      let lastError: Error | null = null
      const attempts = Math.max(1, req.maxRetries + 1)
      for (let i = 0; i < attempts; i++) {
        try {
          return await once(req, signal, emit)
        } catch (e) {
          lastError = e as Error
          if (lastError.name === 'AbortError') throw lastError // 取消不重试
        }
      }
      throw lastError!
    },
  }
}

// 多实例 registry：同一协议可配多个 provider，按名字或所含 model 查找。
export class ProviderRegistry {
  constructor(private providers: ProviderConfig[]) {}

  get(name: string): ProviderConfig | undefined {
    return this.providers.find((p) => p.name === name)
  }

  findByModel(model: string): ProviderConfig | undefined {
    return this.providers.find((p) => p.models.some((m) => m.name === model))
  }
}