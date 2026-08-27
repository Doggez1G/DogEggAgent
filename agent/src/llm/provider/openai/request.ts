import type { ChatRequest } from '../../types'

// ChatRequest → HTTP 请求（URL + init）。
// system 消息在此拼接——ChatRequest.messages 只含 user/assistant/tool 历史，不含 system。
export function buildRequest(req: ChatRequest): { url: string; init: RequestInit } {
  return {
    url: `${req.baseURL.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
        tools: req.tools,
        max_tokens: req.maxOutput,
      }),
    },
  }
}
