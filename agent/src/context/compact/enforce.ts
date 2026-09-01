import type { Message } from '@dogegg/bridge'
import { estimateContextTokens } from '../token/budget'

// 硬上限兜底：当压缩后 context 仍超过窗口 80%（如单条消息极大或压缩失败降级），
// 从头部丢弃最旧的非 system 消息直到降到阈值以下。
// 被丢弃的消息在 history 中仍保留（不影响 UI 显示），只是不再发给模型。
// system 消息不在 context 数组中（由 adapter 拼接），所以这里所有消息都可丢弃。
// 保留最后一条消息——确保模型至少看到最新输入。
export function enforceContextLimit(input: {
  systemPrompt: string
  context: Message[]
  tools: object[]
  windowTokens: number
  threshold?: number // 默认 0.8（80%）
}): { context: Message[]; dropped: number } {
  const threshold = input.threshold ?? 0.8
  const limit = input.windowTokens * threshold
  let context = [...input.context]
  let dropped = 0

  while (context.length > 1 && estimateContextTokens(input.systemPrompt, context, input.tools) > limit) {
    context.shift()
    dropped++
  }

  return { context, dropped }
}
