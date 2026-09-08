import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { editFileSchema, editFileParameters } from './schema'

// edit_file 工具：精准替换文件中首次出现的 old_string → new_string。
// old_string 必须逐字符匹配（含缩进/空白）——这是 code agent 的核心约束，防止误替换。
export class EditFileTool implements Tool {
  readonly name = 'edit_file'
  readonly description = '将文件中首次出现的 old_string 精准替换为 new_string'
  readonly schema = editFileSchema
  readonly parameters = editFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, old_string, new_string } = args as z.infer<typeof editFileSchema>
    try {
      const p = join(ctx.cwd, path)
      const text = await readFile(p, 'utf8')
      if (!text.includes(old_string)) return { error: 'old_string 未找到' }
      // 锚点：old_string 在原文件中的 1-based 起始行。写进回执一举两得——模型知道改动落点
      // 便于后续连续编辑；UI（shared/tool-display）解析它给 diff 标真实行号。
      const startLine = text.slice(0, text.indexOf(old_string)).split('\n').length
      await writeFile(p, text.replace(old_string, new_string), 'utf8')
      return { content: `已替换 1 处（原第 ${startLine} 行起）` }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
