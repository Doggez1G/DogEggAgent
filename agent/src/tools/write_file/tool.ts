import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { writeFileSchema, writeFileParameters } from './schema'
import { atomicWriteFile, resolveTargetPath } from '../../shared'

// write_file 工具：整文件覆写/创建。
// 失败返回 error 串，不抛错（同 read_file 约定）。
export class WriteFileTool implements Tool {
  readonly name = 'write_file'
  readonly description = '整文件覆写或创建'
  readonly schema = writeFileSchema
  readonly parameters = writeFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = args as z.infer<typeof writeFileSchema>
    try {
      // 路径解析走 resolveTargetPath（立法见 shared/target-path.ts）：join 在 Windows 上遇到
      // 绝对路径参数会产生变形路径（盘符冒号被吞），分类与实际写入会指向不同文件。
      // 落盘走原子写（立法见 shared/atomic.ts）：整文件覆写若中途崩溃，半截内容不可自愈。
      await atomicWriteFile(resolveTargetPath(ctx.cwd, path), content)
      return { content: `已写入 ${path}` }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
