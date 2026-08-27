import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { writeFileSchema } from './schema'

// 整文件覆写/创建。失败返回 error 串，不抛错（同 read_file 约定）。
export async function writeFileExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { path, content } = args as z.infer<typeof writeFileSchema>
  try {
    await writeFile(join(ctx.cwd, path), content, 'utf8')
    return { content: `已写入 ${path}` }
  } catch (e) {
    return { error: String(e) }
  }
}
