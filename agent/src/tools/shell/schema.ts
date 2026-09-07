import { z } from 'zod'

// shell 工具参数 schema：单条命令字符串。解释器由配置决定，工具内不拆参数。
export const shellSchema = z.object({ command: z.string() })

// 暴露给 LLM 的 OpenAI JSON schema。
export const shellParameters = {
  type: 'object',
  properties: { command: { type: 'string', description: '要执行的命令' } },
  required: ['command'],
}
