import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types'

const schema = z.object({ path: z.string() })

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容',
  schema,
  parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的文件路径' } }, required: ['path'] },
  async execute(args, ctx) {
    const { path } = args as z.infer<typeof schema>
    try {
      return { content: await readFile(join(ctx.cwd, path), 'utf8') }
    } catch (e) {
      return { error: String(e) }
    }
  },
}