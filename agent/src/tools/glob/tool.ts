import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { z } from 'zod'
import { globToRegExp } from '@dogegg/bridge'
import type { Tool, ToolContext, ToolResult } from '../types'
import { walkFiles, loadGitIgnore } from '../traverse'
import { globSchema, globParameters } from './schema'

// 命中封顶：匹配全部文件名的场景（如 **）在大仓库会产出上万条，无封顶会撑爆上下文。
// 截断注明并提示收窄——「还剩多少 + 怎么办」让模型能自行修正而不是重试同一模式。
const MAX_MATCHES = 100

// glob 工具：按模式递归找文件名（只匹配路径，不读内容——按内容搜是 grep 的事）。
// matcher 来自 bridge（globToRegExp），与权限参数化规则共用一份实现；模式编译一次、遍历内复用。
// 遍历经 traverse 的 walkFiles：黑名单目录剪枝（node_modules 等）、symlink 跳过、产出 posix 相对路径。
export class GlobTool implements Tool {
  readonly name = 'glob'
  readonly description = '按 glob 模式递归查找文件路径（只匹配文件名，不读内容）'
  readonly schema = globSchema
  readonly parameters = globParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path } = args as z.infer<typeof globSchema>
    let re: RegExp
    try {
      re = globToRegExp(pattern)
    } catch (e) {
      return { error: `无效的 glob 模式 ${pattern}：${String(e)}` }
    }
    const root = path ? join(ctx.cwd, path) : ctx.cwd
    // 前置检查：walker 对单目录读失败是「跳过继续」语义（探索不因单点失败中断），
    // 但整个根都不存在必须显式报错——否则「模式写错」和「路径写错」在模型侧不可区分。
    const rootStat = await stat(root).catch(() => null)
    if (!rootStat) return { error: `路径不存在：${path ?? '.'}` }
    // .gitignore（会话 cwd 根）参与过滤（M2.5）；cwd 交给 walker 换算坐标——
    // 规则按 cwd 锚定，子根扫描（path 传入子目录）时必须按 cwd 相对路径判定。
    const gitignore = loadGitIgnore(ctx.cwd)
    const matches: string[] = []
    try {
      for await (const rel of walkFiles(root, { signal: ctx.signal, gitignore, cwd: ctx.cwd })) {
        if (re.test(rel)) {
          matches.push(rel)
          if (matches.length > MAX_MATCHES) break // 只为「知道总数之外还有更多」，总数在此场景不重要
        }
      }
    } catch (e) {
      return { error: `遍历 ${path ?? '.'} 失败：${String(e)}` }
    }
    if (matches.length === 0) return { content: '（无匹配文件）' }
    matches.sort()
    if (matches.length > MAX_MATCHES) {
      matches.length = MAX_MATCHES
      matches.push(`（仅显示前 ${MAX_MATCHES} 个命中，请收窄 pattern）`)
    }
    return { content: matches.join('\n') }
  }
}
