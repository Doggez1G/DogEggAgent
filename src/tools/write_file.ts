import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types'

const schema = z.object({ path: z.string(), content: z.string() })

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '整文件覆写或创建',
  schema,
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] },
  async execute(args, ctx) {
    const { path, content } = args as z.infer<typeof schema>
    try {
      await writeFile(join(ctx.cwd, path), content, 'utf8')
      return { content: `已写入 ${path}` }
    } catch (e) {
      return { error: String(e) }
    }
  },
}