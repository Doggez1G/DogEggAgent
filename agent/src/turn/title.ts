import type { LlmClient } from '../llm'

// 自动标题（M2.5）：首轮成功后为会话生成一次中文短标题，供会话列表展示（替代截断的 preview）。
// 提示词立法：只输出标题本身——超长/引号/前后缀由下方清洗兜底，模型啰嗦时取首行再截断。
const TITLE_PROMPT = '为这段对话生成一个简短的中文标题。只输出标题本身：不超过 32 个字，不加引号、句号或「标题：」之类的前后缀。'

// 用同一 client 做一次「离线」标题生成（不进 agent loop、不发 stream 事件——与 summarizeHistory 同模式）。
// 输入取首条用户消息 + 首条助手消息各前 500 字符（标题只需主题，不需要全文）。
// maxOutput 512：上限不是目标——普通模型生成二十来字即停；但 ChatRequest 无 reasoning 开关，
// 推理模型按模型默认行为思考且思考 token 计入该预算，给 64 会被思考烧光 → content 为空 → 静默失败。
// 失败/空结果返回 null（标题是装饰，调用方静默跳过）。
export async function generateTitle(
  deps: { client: LlmClient; model: string },
  userText: string,
  assistantText: string,
): Promise<string | null> {
  try {
    const res = await deps.client.chat(
      {
        model: deps.model,
        systemPrompt: TITLE_PROMPT,
        messages: [
          {
            role: 'user',
            content: `用户：${userText.slice(0, 500)}
助手：${assistantText.slice(0, 500)}`,
          },
        ],
        tools: [],
        maxOutput: 512,
        maxRetries: 1,
      },
      new AbortController().signal,
      () => {},
    )
    const raw = typeof res.message.content === 'string' ? res.message.content.trim().split('\n')[0]! : ''
    const title = raw.replace(/^["'「『]+|["'」』]+$/g, '').slice(0, 32).trim()
    return title || null
  } catch {
    return null
  }
}
