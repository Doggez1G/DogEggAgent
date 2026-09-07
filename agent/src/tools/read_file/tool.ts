import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { readFileSchema, readFileParameters } from './schema'

// read_file 工具：读取文件内容（相对 cwd）。
// 失败返回 error 串而非抛错——工具错误不中断 loop，而是作为 tool 消息回填模型。
export class ReadFileTool implements Tool {
  readonly name = 'read_file'
  readonly description = '读取文件内容'
  readonly schema = readFileSchema
  readonly parameters = readFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path } = args as z.infer<typeof readFileSchema>
    try {
      return { content: await readFile(join(ctx.cwd, path), 'utf8') }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
