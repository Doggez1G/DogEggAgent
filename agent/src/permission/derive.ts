import { dirname, relative, resolve } from 'node:path'
import { primarySpecifier } from '@dogegg/bridge'

// 范围提升的模式推导：批准一次调用时，给用户一个「最窄的可复用范围」——
// 原则：范围要窄到不放过大片未批准的区域，又要宽到能消除同一片区域的重复审批；
// 且推导不出（参数缺失/形态异常）就返回 undefined，弹层退回三档（fail-safe）。
//
// - command（shell）：首词前缀——命令按「程序名」聚类，首词就是用户心里"这类命令"的边界：
//   `git status` → `git *`；无后续参数（`ls`）→ 精确 `ls`；
// - path（read/write/edit/ls/glob/grep）：所在目录 `./<dir>/**`——重复审批的痛点来自同一片区域
//   反复改；**文件在 cwd 根部时回退精确 `./<file>`**（父目录即 cwd，给 `./**` 等于放行全项目）；
// - 其余（无主参数）→ undefined。
//
// 返回 cwd 相对形式（./ 前缀），由调用方在提升落库时解析为绝对形式（见 PermissionManager.apply）。
export function deriveAlwaysScope(tool: string, input: unknown, cwd: string): string | undefined {
  const key = primarySpecifier(tool)
  const input_ = input as { command?: unknown; path?: unknown } | null

  if (key === 'command') {
    const cmd = input_?.command
    if (typeof cmd !== 'string') return undefined
    const tokens = cmd.trim().split(/\s+/).filter((t) => t !== '')
    if (tokens.length === 0) return undefined
    return tokens.length > 1 ? `${tokens[0]} *` : tokens[0]!
  }

  if (key === 'path') {
    const p = input_?.path
    if (typeof p !== 'string' || p.trim() === '') return undefined
    const cwdAbs = resolve(cwd)
    const abs = resolve(cwdAbs, p)
    const rel = relative(cwdAbs, abs).replace(/\\/g, '/')
    if (rel === '' || rel.startsWith('..')) return undefined // 参数即 cwd 本身 / 在 cwd 外：不提供范围提升（保守）
    const dir = dirname(rel)
    return dir === '.' ? `./${rel}` : `./${dir}/**`
  }

  return undefined
}
