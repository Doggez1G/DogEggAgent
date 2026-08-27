import type { Message } from '@dogegg/bridge'

// 压缩切分：保留最近 keep 条原文（fresh），更早的（old）交给 LLM 总结。
// keep=4 是经验值——保留足够近期上下文让模型续接，又不至于太旧的信息丢失（旧信息进了摘要）。
export function splitForCompaction(messages: Message[], keep = 4): { old: Message[]; fresh: Message[] } {
  if (messages.length <= keep) return { old: [], fresh: [...messages] }
  return { old: messages.slice(0, messages.length - keep), fresh: messages.slice(messages.length - keep) }
}
