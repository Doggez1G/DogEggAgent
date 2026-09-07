import type { Message } from '@dogegg/bridge'
import { estimateContextTokens, shouldCompact, splitForCompaction } from '../context'

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

// 压缩编排器：统一压缩入口（loop 自动触发 + 手动 /compact 都走这里）。
// ⚠️ R1 核心约束：只压缩 Context，绝不触碰 History——接收 context 数组、返回压缩后的新数组；
// History 由 core 持有并保持原样不变。压缩结果 = [摘要消息, ...最近 keep 条原文]；旧消息被摘要替代。
//
// summarize 回调构造注入（core 组装，避免直接依赖 llm client）。force 语义：
//   - force=false（loop 自动触发）：仅当 token 超过窗口 80% 时才压缩。
//   - force=true（/compact 手动触发）：无条件压缩——跳过阈值检查。
//   两种情况都要求 context 非空（至少 1 条消息才压）。
//   splitForCompaction 的 keep=4：消息 >4 条时压旧的留近期；≤4 条时 old 为空，
//   force 模式下把全部消息都交给摘要（keep 降为 0），保证少消息也能压缩。
export class Compactor {
  constructor(private readonly summarize: (old: Message[], signal?: AbortSignal) => Promise<string>) {}

  async compact(input: {
    context: Message[]
    systemPrompt: string
    tools: object[]
    windowTokens: number
    force?: boolean
    signal?: AbortSignal // 传给 summarize 的取消信号（压缩期间 cancel 可中断 LLM 调用）
  }): Promise<CompactResult> {
    const before = estimateContextTokens(input.systemPrompt, input.context, input.tools)
    // context 为空直接跳过——没东西可压。
    if (input.context.length === 0) {
      return { compacted: false, context: input.context, before, after: before }
    }
    // 手动压缩无条件执行；自动压缩需超过窗口 80% 才触发。
    if (!input.force && !shouldCompact(before, input.windowTokens)) {
      return { compacted: false, context: input.context, before, after: before }
    }
    // 切分：自动压缩保留最近 4 条原文；手动压缩时如果消息太少（≤4 条），把全部都交给摘要。
    const keep = input.force ? Math.min(4, Math.max(0, input.context.length - 1)) : 4
    const { old, fresh } = splitForCompaction(input.context, keep)
    // old 为空意味着所有消息都在 fresh 里（消息太少）——force 模式下把 fresh 也交给摘要。
    const toSummarize = old.length > 0 ? old : fresh
    const toKeep = old.length > 0 ? fresh : []
    if (toSummarize.length === 0) {
      return { compacted: false, context: input.context, before, after: before }
    }
    const summary = await this.summarize(toSummarize, input.signal)
    const context = [{ role: 'user' as const, content: `[前文摘要]\n${summary}` }, ...toKeep]
    return { compacted: true, context, before, after: estimateContextTokens(input.systemPrompt, context, input.tools) }
  }
}
