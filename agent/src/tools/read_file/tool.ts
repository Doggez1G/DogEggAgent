import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { readFileSchema, readFileParameters } from './schema'

// 读取上限立法：与 grep 的 1MB/文件防护对齐——超大文件整份读进内存既可能 OOM，
// 也会一次性灌爆上下文。先 stat 拦下，指引模型改走「grep 定位 → 再读」的探索漏斗。
const READ_FILE_MAX_BYTES = 1024 * 1024

// read_file 工具：读取文件内容（相对 cwd）。
// 失败返回 error 串而非抛错——工具错误不中断 loop，而是作为 tool 消息回填模型。
export class ReadFileTool implements Tool {
  readonly name = 'read_file'
  readonly description = '读取文件内容'
  readonly schema = readFileSchema
  readonly parameters = readFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path } = args as z.infer<typeof readFileSchema>
    const p = join(ctx.cwd, path)
    try {
      const info = await stat(p)
      if (info.size > READ_FILE_MAX_BYTES) {
        return { error: `文件超过 1MB（${info.size} 字节），请改用 grep 定位后再读取所需片段` }
      }
      return { content: await readFile(p, 'utf8') }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
