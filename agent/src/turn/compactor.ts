import type { Message } from '@dogegg/bridge'
import { estimateContextTokens, shouldCompact } from '../context'

export interface CompactResult {
  /** 是否实际压缩了（未达阈值或无可压内容时为 false）。 */
  compacted: boolean
  /** 压缩后的新 Context（未压缩时原样返回）。 */
  context: Message[]
  /** 压缩前 token 数。 */
  before: number
  /** 压缩后 token 数（未压缩时等于 before）。 */
  after: number
}

// 摘要消息头标注——后续对话里模型据此知道此前的上下文已被压缩为摘要。
const SUMMARY_HEADER = '[对话已压缩——以下是此前上下文的结构化摘要]'

// 压缩编排器：统一压缩入口（loop 自动触发 + 手动 /compact 都走这里）。
// ⚠️ R1 核心约束：只压缩 Context，绝不触碰 History——接收 context 数组、返回压缩后的新数组；
// History 由 conversation 持有并保持原样不变。
//
// 压缩语义（M2 重构，见 2026-09-10-context-engineering-design.md）：
// **把整个 context 交给模型总结，替换为一条摘要消息**——无保留尾巴（keep=N 已废，切缝会拆散
// tool_calls/tool 配对）、无淘汰、无硬丢弃兜底。摘要是「任务交接文档」（结构化提示词见 summarize.ts），
// 是模型继续工作的唯一上下文；下次压缩对 [摘要 + 新对话] 重新完整总结，无叠加劣化。
//
// 失败语义（诚实失败）：summarize 抛错（LLM 调用失败）或返回空摘要 → 异常上抛，
// 调用方（loop/turn-runner）按错误收尾——不做降级，由用户决定 /compact 重试或 /new。
//
// force 语义：force=true（/compact 手动）跳过阈值检查无条件压缩；force=false（自动）需超窗口 80%。
export class Compactor {
  constructor(private readonly summarize: (messages: Message[], signal?: AbortSignal) => Promise<string>) {}

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
    // 全量交给模型总结——摘要将作为后续对话的唯一上下文（任务交接文档）。
    const summary = await this.summarize(input.context, input.signal)
    if (!summary.trim()) {
      // 空摘要会让后续对话失去全部上下文——视为压缩失败而非静默通过。
      throw new Error('压缩摘要为空')
    }
    const context = [{ role: 'user' as const, content: `${SUMMARY_HEADER}\n${summary}` }]
    const after = estimateContextTokens(input.systemPrompt, context, input.tools)
    // 非劣原则：压缩的产出不能比原文更大。简短/寒暄对话的交接文档可能比原文还长
    //（结构化提示词鼓励逐项展开）——此时压缩没有意义，按未压缩返回。自动路径天然不受影响
    //（80% 触发时 context 已很大，摘要必然更短）；主要是手动 /compact 小 context 的保护。
    if (after >= before) {
      return { compacted: false, context: input.context, before, after: before }
    }
    return { compacted: true, context, before, after }
  }
}
