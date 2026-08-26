import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types'

const schema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })

export const editFileTool: Tool = {
  name: 'edit_file',
  description: '将文件中首次出现的 old_string 精准替换为 new_string',
  schema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: '要替换的原文片段，需与文件内容逐字符一致' },
      new_string: { type: 'string', description: '替换后的新片段' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const { path, old_string, new_string } = args as z.infer<typeof schema>
    try {
      const p = join(ctx.cwd, path)
      const text = await readFile(p, 'utf8')
      if (!text.includes(old_string)) return { error: 'old_string 未找到' }
      await writeFile(p, text.replace(old_string, new_string), 'utf8')
      return { content: '已替换 1 处' }
    } catch (e) {
      return { error: String(e) }
    }
  },
}