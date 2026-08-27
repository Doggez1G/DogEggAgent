import type { Message } from '@dogegg/bridge'
import type { ProviderAdapter } from '../../llm/types'

// 用同一 adapter 做一次「离线」总结，把最旧的 Context 消息压成一段中文摘要。
// 「离线」指不进 agent loop、不发 stream 事件——只是单次 chat 调用拿一个文本结果。
// 摘要是压缩后的替代，不含 tool_calls，故 tools 传空、maxOutput 控制长度。
export async function summarizeHistory(
  deps: { adapter: ProviderAdapter; providerBaseURL: string; apiKey: string; model: string },
  old: Message[],
): Promise<string> {
  const assistant = await deps.adapter.chat(
    {
      baseURL: deps.providerBaseURL,
      apiKey: deps.apiKey,
      model: deps.model,
      systemPrompt: '你是上下文压缩器。把这段对话压缩成一段简洁的中文摘要，保留关键事实、结论与未完成事项。',
      messages: old,
      tools: [],
      maxOutput: 1000,
      maxRetries: 1,
    },
    new AbortController().signal,
    () => {},
  )
  return typeof assistant.content === 'string' ? assistant.content : ''
}
