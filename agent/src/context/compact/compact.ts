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
//
// force 语义：
//   - force=false（默认，loop 自动触发）：仅当 token 超过窗口 80% 时才压缩。
//   - force=true（/compact 手动触发）：无条件压缩——跳过阈值检查，只要 old 非空就压。
//   两种情况都跳过「无可压缩旧历史」（old.length === 0）。
export async function compactContext(input: {
  context: Message[]
  systemPrompt: string
  tools: object[]
  windowTokens: number
  summarize: (old: Message[]) => Promise<string>
  force?: boolean
}): Promise<CompactResult> {
  const before = estimateContextTokens(input.systemPrompt, input.context, input.tools)
  // 手动压缩无条件执行；自动压缩需超过窗口 80% 才触发。
  if (!input.force && !shouldCompact(before, input.windowTokens)) {
    return { compacted: false, context: input.context, before, after: before }
  }
  const { old, fresh } = splitForCompaction(input.context)
  if (old.length === 0) {
    // 即使 force，没有旧历史可压也跳过。
    return { compacted: false, context: input.context, before, after: before }
  }
  const summary = await input.summarize(old)
  const context = [{ role: 'user' as const, content: `[前文摘要]\n${summary}` }, ...fresh]
  return { compacted: true, context, before, after: estimateContextTokens(input.systemPrompt, context, input.tools) }
}
