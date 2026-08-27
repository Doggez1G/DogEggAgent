import type { Tool } from '../types'
import { writeFileSchema } from './schema'
import { writeFileExecute } from './execute'

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '整文件覆写或创建',
  schema: writeFileSchema,
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] },
  execute: writeFileExecute,
}
