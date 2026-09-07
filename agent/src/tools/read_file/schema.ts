import { z } from 'zod'

// read_file 工具参数 schema：相对工作目录的文件路径。
export const readFileSchema = z.object({ path: z.string() })

// 暴露给 LLM 的 OpenAI JSON schema。
export const readFileParameters = {
  type: 'object',
  properties: { path: { type: 'string', description: '相对工作目录的文件路径' } },
  required: ['path'],
}
