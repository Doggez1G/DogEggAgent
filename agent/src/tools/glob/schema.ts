import { z } from 'zod'

// glob 工具参数 schema：模式 + 可选起点目录（缺省 = 会话工作目录）。
export const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
})

// 暴露给 LLM 的 OpenAI JSON schema。
export const globParameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'glob 模式，如 **/*.test.ts；** 跨段、* 单段、? 单字符' },
    path: { type: 'string', description: '可选：开始搜索的目录（相对工作目录），缺省为工作目录根' },
  },
  required: ['pattern'],
}
