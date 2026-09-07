import { z } from 'zod'

// edit_file 工具参数 schema：路径 + 要替换的原文 + 新片段。code agent 的核心工具。
export const editFileSchema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })

// 暴露给 LLM 的 OpenAI JSON schema。
export const editFileParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    old_string: { type: 'string', description: '要替换的原文片段，需与文件内容逐字符一致' },
    new_string: { type: 'string', description: '替换后的新片段' },
  },
  required: ['path', 'old_string', 'new_string'],
}
