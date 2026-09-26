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
        // include_usage：流式模式拿到真实用量（usage 随流末尾的独立 chunk 返回）。
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: req.systemPrompt }, ...req.messages],
        tools: req.tools,
        // 【立法 P1-7】maxOutput = -1 是 bridge 契约的「不设限」语义（config schema：-1 或正整数）。
        // OpenAI 协议没有「无限」的表达——直接下发 max_tokens: -1 会被严格实现判 400（该字段
        // 须为正整数）。此处省略 max_tokens 字段，由服务端取该模型的输出上限；正数时照常携带。
        ...(req.maxOutput === -1 ? {} : { max_tokens: req.maxOutput }),
      }),
    },
  }
}
