import type { Tool } from '../types'
import { readFileSchema } from './schema'
import { readFileExecute } from './execute'

// read_file 工具定义：schema（zod 校验）+ parameters（暴露给 LLM 的 OpenAI JSON schema）+ execute。
export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容',
  schema: readFileSchema,
  parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的文件路径' } }, required: ['path'] },
  execute: readFileExecute,
}
