import { z } from 'zod'

// write_file 工具参数 schema：文件路径 + 完整内容（整文件覆写）。
export const writeFileSchema = z.object({ path: z.string(), content: z.string() })

// 暴露给 LLM 的 OpenAI JSON schema。
export const writeFileParameters = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string', description: '文件完整内容' } },
  required: ['path', 'content'],
}
