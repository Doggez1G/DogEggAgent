import type { Message } from '@dogegg/bridge'
import type { LlmClient } from '../llm'

// 压缩摘要 = 「任务交接文档」。摘要将作为后续对话的唯一上下文（M2 压缩语义：
// 全量交给模型总结、无保留尾巴），因此提示词按结构化交接设计而非单纯"缩写"——
// 保留任务目标/已完成/文件路径/决策/待办，让新的助手实例能无缝接续。丢与不丢的分水岭在这里。
// maxOutput 2000：摘要是唯一上下文，1000 会截断长任务的交接信息。
const HANDOVER_PROMPT = [
  '你是对话上下文压缩器。把整段对话历史总结成一份「任务交接文档」，让一个新的助手实例仅凭这份摘要就能无缝继续这项工作。',
  '必须逐项保留（该类别在对话中不存在则省略，不要编造）：',
  '1. 当前任务目标与用户的核心诉求；',
  '2. 已完成的步骤与结果；',
  '3. 涉及的文件路径与关键代码位置；',
  '4. 重要决策及其理由；',
  '5. 未完成事项与下一步计划；',
  '6. 用户的偏好与约束。',
  '用中文、结构化条目输出。这份摘要将作为后续对话的唯一上下文。',
  '输出长度须与信息密度匹配：摘要必须显著短于原文；寒暄、问候等低密度对话一两句话总结即可，不要为了凑齐类别而展开。',
].join('\n')

// 用同一 client 做一次「离线」总结，把整个 Context 压成一份交接摘要。
// 「离线」指不进 agent loop、不发 stream 事件——只是单次 chat 调用拿一个文本结果。
// 摘要不含 tool_calls，tools 传空；maxOutput 2000（摘要是唯一上下文，需要足够空间）。
// signal 接收外部 signal 让取消能中断摘要调用（非 new AbortController 无人持有）。
export async function summarizeHistory(
  deps: { client: LlmClient; model: string },
  old: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const assistant = await deps.client.chat(
    {
      model: deps.model,
      systemPrompt: HANDOVER_PROMPT,
      messages: old,
      tools: [],
      maxOutput: 2000,
      maxRetries: 1,
    },
    signal ?? new AbortController().signal,
    () => {},
  )
  return typeof assistant.message.content === 'string' ? assistant.message.content : ''
}
