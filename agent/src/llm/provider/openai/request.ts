import type { ChatRequest, LlmClientConn } from '../..'

// ChatRequest + 连接参数 → HTTP 请求（URL + init）。
// system 消息在此拼接——ChatRequest.messages 只含 user/assistant/tool 历史，不含 system。
export function buildRequest(req: ChatRequest, conn: LlmClientConn): { url: string; init: RequestInit } {
  return {
    url: `${conn.baseURL.replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
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
