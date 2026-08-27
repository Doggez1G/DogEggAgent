import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { ToolContext, ToolResult } from '../types'
import { editFileSchema } from './schema'

// 精准替换：文件中首次出现的 old_string → new_string。
// old_string 必须逐字符匹配（含缩进/空白）——这是 code agent 的核心约束，防止误替换。
export async function editFileExecute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { path, old_string, new_string } = args as z.infer<typeof editFileSchema>
  try {
    const p = join(ctx.cwd, path)
    const text = await readFile(p, 'utf8')
    if (!text.includes(old_string)) return { error: 'old_string 未找到' }
    await writeFile(p, text.replace(old_string, new_string), 'utf8')
    return { content: '已替换 1 处' }
  } catch (e) {
    return { error: String(e) }
  }
}
