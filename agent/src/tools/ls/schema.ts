import { z } from 'zod'

// ls 工具参数 schema：相对工作目录的目录路径（单层，不递归——递归找文件是 glob 的事）。
export const lsSchema = z.object({ path: z.string() })

// 暴露给 LLM 的 OpenAI JSON schema。
export const lsParameters = {
  type: 'object',
  properties: { path: { type: 'string', description: '相对工作目录的目录路径；列出该目录一层内容（子目录标注 /）' } },
  required: ['path'],
}
