import type { Tool } from '../types'
import { editFileSchema } from './schema'
import { editFileExecute } from './execute'

export const editFileTool: Tool = {
  name: 'edit_file',
  description: '将文件中首次出现的 old_string 精准替换为 new_string',
  schema: editFileSchema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要替换的原文片段，需与文件内容逐字符一致' },
      new_string: { type: 'string', description: '替换后的新片段' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: editFileExecute,
}
