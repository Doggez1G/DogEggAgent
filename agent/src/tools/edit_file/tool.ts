import { readFile } from 'node:fs/promises'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { editFileSchema, editFileParameters } from './schema'
import { atomicWriteFile, resolveTargetPath } from '../../shared'

// edit_file 工具：精准替换文件中首次出现的 old_string → new_string。
// old_string 必须逐字符匹配（含缩进/空白）——这是 code agent 的核心约束，防止误替换。
// 边界立法：old_string 为空一律拒绝——空串会命中文件开头（index 0），把 new_string 静默
// 插到文件头（schema 层 .min(1) 是第一道关口，这里对绕过 schema 的直调路径双保险）；
// new_string 为空则合法，语义是「删除 old_string 片段」。
export class EditFileTool implements Tool {
  readonly name = 'edit_file'
  readonly description = '将文件中首次出现的 old_string 精准替换为 new_string'
  readonly schema = editFileSchema
  readonly parameters = editFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, old_string, new_string } = args as z.infer<typeof editFileSchema>
    if (!old_string) return { error: 'old_string 不能为空' }
    try {
      // 路径解析走 resolveTargetPath（立法见 shared/target-path.ts）：join 在 Windows 上遇到
      // 绝对路径参数会产生变形路径（盘符冒号被吞），读取与分类会指向不同文件。
      const p = resolveTargetPath(ctx.cwd, path)
      const text = await readFile(p, 'utf8')
      if (!text.includes(old_string)) return { error: 'old_string 未找到' }
      // 锚点：old_string 在原文件中的 1-based 起始行。写进回执一举两得——模型知道改动落点
      // 便于后续连续编辑；UI（shared/tool-display）解析它给 diff 标真实行号。
      const startLine = text.slice(0, text.indexOf(old_string)).split('\n').length
      // 函数形态替换（先例：skills/manager.ts 的 forInvocation）：字符串形态的替换值里
      // $& / $` / $' / $$ 会被重新解释（$& = 整个匹配、$$ = 字面 $ 等），new_string 里的
      // 这些序列会被篡改写入；函数返回值按字面插入，不做二次解释。
      // String.replace 只替换首个匹配——多处出现的语义是「只改第一处」（测试固化该行为）。
      await atomicWriteFile(p, text.replace(old_string, () => new_string))
      return { content: `已替换 1 处（原第 ${startLine} 行起）` }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
