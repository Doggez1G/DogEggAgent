import type { Tool } from '../types'
import { shellSchema } from './schema'
import { shellExecute } from './execute'

export const shellTool: Tool = {
  name: 'shell',
  description: '执行 shell 命令，捕获 stdout/stderr 与 exit code',
  schema: shellSchema,
  parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] },
  execute: shellExecute,
}

// interpreter 的解析函数也导出（测试与潜在复用），但经 index 而非直接指向 interpreter.ts（模块边界）。
export { resolveShell, defaultShell, type ShellSpec } from './interpreter'

