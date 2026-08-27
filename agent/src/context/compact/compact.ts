import type { Message } from '@dogegg/bridge'
import { estimateContextTokens } from '../token/budget'
import { shouldCompact } from './trigger'
import { splitForCompaction } from './split'

export interface CompactResult {
  /** 是否实际压缩了（未达阈值或无旧历史可压时为 false）。 */
  compacted: boolean
  /** 压缩后的新 Context（未压缩时原样返回）。 */
  context: Message[]
  /** 压缩前 token 数。 */
  before: number
  /** 压缩后 token 数（未压缩时等于 before）。 */
  after: number
}

// 统一压缩入口（自动触发 + 手动 /compact 都调它）。
// ⚠️ R1 核心约束：此函数只压缩 Context，**绝不触碰 History**。
// 它接收 context 数组、返回压缩后的新 context 数组；History 由 core/agent.ts 持有并保持原样不变。
// 压缩结果 = [摘要消息, ...最近 keep 条原文]；旧消息被摘要替代。
// 调用方（loop 自动 / Agent 手动）各自决定是否 emit compaction 与持久化。
export async function compactContext(input: {
  context: Message[]
  systemPrompt: string
  tools: object[]
  windowTokens: number
  summarize: (old: Message[]) => Promise<string>
}): Promise<CompactResult> {
  const before = estimateContextTokens(input.systemPrompt, input.context, input.tools)
  if (!shouldCompact(before, input.windowTokens)) {
    return { compacted: false, context: input.context, before, after: before }
  }
  const { old, fresh } = splitForCompaction(input.context)
  if (old.length === 0) {
    return { compacted: false, context: input.context, before, after: before }
  }
  const summary = await input.summarize(old)
  const context = [{ role: 'user' as const, content: `[前文摘要]\n${summary}` }, ...fresh]
  return { compacted: true, context, before, after: estimateContextTokens(input.systemPrompt, context, input.tools) }
}
