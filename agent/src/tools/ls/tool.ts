import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { lsSchema, lsParameters } from './schema'

// 条目封顶：目录可能巨大（构建产物、缓存），无封顶的回执会撑爆上下文。
// 对齐 read_file 的治理先例：截断处注明，让模型知道还有更多并自行收窄。
const MAX_ENTRIES = 500

// 人类可读大小（B/KB/MB）——模型与用户都按数量级理解文件，原始字节数是噪音。
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ls 工具：列出目录一层内容（跨平台、结构化——不代理 shell 的 dir/ls，见设计 §2 立法）。
// 目录在前（加 / 后缀）、文件在后，各自按名排序——模型浏览项目结构时先看到拓扑再看到内容。
// 隐藏文件（. 开头）正常显示：agent 需要看 .github/.gitignore 等，黑名单只作用于递归遍历。
export class LsTool implements Tool {
  readonly name = 'ls'
  readonly description = '列出目录一层内容（子目录标注 /，附文件大小；单层不递归）'
  readonly schema = lsSchema
  readonly parameters = lsParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path } = args as z.infer<typeof lsSchema>
    const abs = join(ctx.cwd, path)
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      const dirs: string[] = []
      const files: string[] = []
      for (const e of entries) {
        if (e.isDirectory()) {
          dirs.push(`${e.name}/`)
        } else if (e.isFile()) {
          // 大小获取失败（竞态删除等）不致命——条目仍列出，大小显示为 ?。
          let size = '?'
          try { size = formatSize((await stat(join(abs, e.name))).size) } catch { /* keep ? */ }
          files.push(`${e.name}  ${size}`)
        }
        // symlink 跳过：与 walker 同一立场（探索不跟链接，避免环与逃逸 root）。
      }
      dirs.sort()
      files.sort()
      const all = [...dirs, ...files]
      const lines = all.length > MAX_ENTRIES
        ? [...all.slice(0, MAX_ENTRIES), `（仅显示前 ${MAX_ENTRIES} 项，共 ${all.length} 项）`]
        : all
      return { content: lines.length > 0 ? lines.join('\n') : '（空目录）' }
    } catch (e) {
      return { error: `无法读取目录 ${path}：${String(e)}` }
    }
  }
}
