import { z } from 'zod'

// edit_file 工具参数 schema：路径 + 要替换的原文 + 新片段。code agent 的核心工具。
// old_string 必须非空：空串的 replace 会命中文件开头（index 0），把 new_string 静默插到文件头——
// 这不是模型想要的「编辑」而是破坏。new_string 为空则合法：语义是「删除片段」（见 tool.ts）。
export const editFileSchema = z.object({
  path: z.string(),
  old_string: z.string().min(1, 'old_string 不能为空——空串会在文件头静默插入；删除内容请把 new_string 留空'),
  new_string: z.string(),
})

// 暴露给 LLM 的 OpenAI JSON schema。
export const editFileParameters = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    old_string: { type: 'string', description: '要替换的原文片段，需与文件内容逐字符一致，不能为空' },
    new_string: { type: 'string', description: '替换后的新片段；留空（空串）表示删除 old_string' },
  },
  required: ['path', 'old_string', 'new_string'],
}
