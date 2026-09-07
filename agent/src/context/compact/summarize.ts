import type { Message } from '@dogegg/bridge'
import type { LlmClient } from '../../llm'

// 用同一 client 做一次「离线」总结，把最旧的 Context 消息压成一段中文摘要。
// 「离线」指不进 agent loop、不发 stream 事件——只是单次 chat 调用拿一个文本结果。
// 摘要是压缩后的替代，不含 tool_calls，故 tools 传空、maxOutput 控制长度。
// signal 接收外部 signal 让取消能中断摘要调用（非 new AbortController 无人持有）。
export async function summarizeHistory(
  deps: { client: LlmClient; model: string },
  old: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const assistant = await deps.client.chat(
    {
      model: deps.model,
      systemPrompt: '你是上下文压缩器。把这段对话压缩成一段简洁的中文摘要，保留关键事实、结论与未完成事项。',
      messages: old,
      tools: [],
      maxOutput: 1000,
      maxRetries: 1,
    },
    signal ?? new AbortController().signal,
    () => {},
  )
  return typeof assistant.message.content === 'string' ? assistant.message.content : ''
}
