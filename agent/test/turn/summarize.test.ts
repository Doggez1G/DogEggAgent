import { describe, it, expect } from 'vitest'
import { summarizeHistory } from '../../src/turn/summarize'
import type { Message } from '@dogegg/bridge'
import type { ChatRequest, ChatResult, LlmClient, LlmStreamEvent } from '../../src/llm'

// ─────────────────────────────────────────────────────────────────────────────
// summarizeHistory 构造契约测试：compactor.test 全程注入「假 summarize」（只返回固定文本），
// 真实压缩 prompt 的构造零覆盖——本文件补上。只测构造契约，不测摘要质量：
//   1. 交接文档 prompt 的结构不变量（按 summarize.ts 实际段落断言，勿臆造）；
//   2. 超长输入的转发策略（见下方「超长」用例的实现对齐说明）；
//   3. chat 抛错/空结果的传播语义与 compactor 的既有断言方向兼容
//     （compactor.test：summarize 抛错原样上抛 = 「诚实失败」；空摘要由 compactor 判为压缩失败）。
// ─────────────────────────────────────────────────────────────────────────────

// 捕获请求的假 client：记录每次 chat 的请求与 signal，按脚本返回内容或抛错。
function capturingClient(script: { content: string | null } | { error: Error }): {
  client: LlmClient
  requests: ChatRequest[]
  signals: AbortSignal[]
} {
  const requests: ChatRequest[] = []
  const signals: AbortSignal[] = []
  const client: LlmClient = {
    async chat(req: ChatRequest, signal: AbortSignal, _emit: (e: LlmStreamEvent) => void): Promise<ChatResult> {
      requests.push(req)
      signals.push(signal)
      if ('error' in script) throw script.error
      return { message: { role: 'assistant', content: script.content }, reasoning: undefined }
    },
  }
  return { client, requests, signals }
}

describe('summarizeHistory（压缩 prompt 构造契约）', () => {
  it('构造契约：交接文档 prompt 含六类保留段 + 唯一上下文立法；old 全量转发；离线调用参数固定', async () => {
    const old: Message[] = [
      { role: 'user', content: '帮我实现快速排序' },
      { role: 'assistant', content: '已完成实现，文件在 src/sort.ts' },
    ]
    const { client, requests, signals } = capturingClient({ content: '## 任务交接文档' })
    const signal = new AbortController().signal
    const summary = await summarizeHistory({ client, model: 'm' }, old, signal)

    // 返回值 = chat 的文本 content 原样。
    expect(summary).toBe('## 任务交接文档')
    expect(requests).toHaveLength(1)
    const req = requests[0]!

    // 交接文档的保留段（HANDOVER_PROMPT 实际六项——任务目标/已完成/文件路径/决策/未完成/偏好）。
    expect(req.systemPrompt).toContain('任务目标')
    expect(req.systemPrompt).toContain('已完成')
    expect(req.systemPrompt).toContain('文件路径')
    expect(req.systemPrompt).toContain('决策')
    expect(req.systemPrompt).toContain('未完成')
    expect(req.systemPrompt).toContain('偏好')
    // 摘要作为后续对话唯一上下文的立法声明 + 结构化输出要求。
    expect(req.systemPrompt).toContain('唯一上下文')
    expect(req.systemPrompt).toContain('结构化')

    // 全量 old 原样转发（无 keep 尾巴——M2 压缩语义：整个 context 交给模型总结）。
    expect(req.messages).toEqual(old)
    // 离线调用：不发工具 schema、输出预算与重试为摘要专用值、模型透传。
    expect(req.tools).toEqual([])
    expect(req.maxOutput).toBe(2000)
    expect(req.maxRetries).toBe(1)
    expect(req.model).toBe('m')
    // 外部 signal 透传（取消能中断摘要调用——非无人持有的 new AbortController）。
    expect(signals[0]).toBe(signal)
  })

  it('超长旧消息：构造的 prompt 恒定不随输入增长；消息原样全量转发（截断决策不在本层）', async () => {
    // 实现对齐说明：summarize 不做消息截断——超长历史被原样转发给 chat，
    // 「总长受控」由其构造的唯一新增部分（systemPrompt）承担：它是固定的交接文档提示词，
    // 与输入规模无关。断言据此对齐实现（若未来在 summarize 层引入截断，此处 messages 断言会红，
    // 属于有意的回归哨兵）。
    const short: Message[] = [{ role: 'user', content: '短' }]
    const huge: Message[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `超长消息 ${i} `.repeat(500),
    }))

    const a = capturingClient({ content: '摘要' })
    await summarizeHistory({ client: a.client, model: 'm' }, short)
    const b = capturingClient({ content: '摘要' })
    await summarizeHistory({ client: b.client, model: 'm' }, huge)

    // 构造的 prompt（systemPrompt）长度恒定——不随输入增长。
    expect(b.requests[0]!.systemPrompt).toBe(a.requests[0]!.systemPrompt)
    // 超长输入不在此层截断/变形：条数与内容原样转发。
    expect(b.requests[0]!.messages).toEqual(huge)
    expect(b.requests[0]!.messages).toHaveLength(200)
  })

  it('chat 抛错原样上抛（与 compactor.test「诚实失败：summarize 抛错」的语义方向一致）', async () => {
    const { client, requests } = capturingClient({ error: new Error('LLM 挂了') })
    await expect(
      summarizeHistory({ client, model: 'm' }, [{ role: 'user', content: 'x' }]),
    ).rejects.toThrow('LLM 挂了')
    // 抛错前请求已按构造契约发出（summarize 不吞错、不重试降级——重试由请求层 maxRetries 负责）。
    expect(requests).toHaveLength(1)
  })

  it('空/非字符串 content 返回空串（compactor 据此判「压缩摘要为空」——两层语义衔接）', async () => {
    const old: Message[] = [{ role: 'user', content: 'x' }]
    // 空串：summarize 原样返回，compactor 的空摘要守卫负责把它升级为压缩失败。
    const empty = capturingClient({ content: '' })
    expect(await summarizeHistory({ client: empty.client, model: 'm' }, old)).toBe('')
    // null content（assistant 消息 content 可为 null）：非字符串归空串，不抛错。
    const nullContent = capturingClient({ content: null })
    expect(await summarizeHistory({ client: nullContent.client, model: 'm' }, old)).toBe('')
    // 不传 signal 时也会传入一个 AbortSignal（非 undefined——chat 契约要求 signal 参数存在）。
    expect(empty.signals[0]).toBeInstanceOf(AbortSignal)
  })
})
