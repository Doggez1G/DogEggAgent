import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { globToRegExp } from '@dogegg/bridge'

// .gitignore 核心子集解析（M2.5）：把项目根的 .gitignore 编译成谓词，供遍历（walker）过滤。
// 支持的语义（gitignore 惯例子集）：
// - `#` 注释与空行跳过；
// - 封口 `/`（如 `build/`）= 仅目录；未封口则文件与目录都匹配；
// - 模式含 `/`（除尾 `/`）或以 `/` 开头 = 相对仓库根锚定；不含 `/` = 匹配任意层级的目录/文件名；
// - `*` `**` `?` 通配（globToRegExp：* 单段、** 跨段）；
// - `!` 取反：**后匹配优先**（gitignore 顺序语义——最后一条命中的规则决定去留）。
// 不支持（立法，v1 从简）：嵌套 .gitignore、字符组 []、`\#` 转义、`**` 与 `/` 的复杂组合边界。
// 匹配大小写敏感（对齐 git）。
export interface GitIgnoreMatcher {
  (relPath: string, isDir: boolean): boolean
}

interface IgnoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

// 单条 .gitignore 规则 → 锚定 glob 正则。
function compileRule(body: string): { re: RegExp; dirOnly: boolean } {
  const dirOnly = body.endsWith('/')
  let core = dirOnly ? body.slice(0, -1) : body
  // 锚定语义（gitignore）：以 `/` 开头，或模式内含 `/`（除尾）→ 相对仓库根锚定；
  // 纯名字（无任何 /）→ 匹配任意层级的同名目录/文件（前缀 **/）。
  const rootAnchored = core.startsWith('/')
  if (rootAnchored) core = core.slice(1)
  const pattern = rootAnchored || core.includes('/') ? core : `**/${core}`
  return { re: globToRegExp(pattern), dirOnly }
}

// 读取并编译 rootDir/.gitignore；文件不存在或读取失败返回 undefined（无忽略规则，行为不变）。
export function loadGitIgnore(rootDir: string): GitIgnoreMatcher | undefined {
  const file = join(rootDir, '.gitignore')
  if (!existsSync(file)) return undefined
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const rules: IgnoreRule[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const negated = t.startsWith('!')
    const body = negated ? t.slice(1).trim() : t
    if (body === '') continue
    try {
      const { re, dirOnly } = compileRule(body)
      rules.push({ re, negated, dirOnly })
    } catch {
      continue // 单条非法模式跳过，不拖垮整个忽略表
    }
  }
  if (rules.length === 0) return undefined

  // gitignore 顺序语义：逐条判定，后命中的覆盖先命中的（! 取反即靠顺序生效）。
  return (relPath: string, isDir: boolean): boolean => {
    let ignored = false
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue
      if (r.re.test(relPath)) ignored = !r.negated
    }
    return ignored
  }
}
