import { readdirSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// @path 输入联想（M2.5）：输入末尾出现 @<路径片段> 时，给出候选（目录优先）。
// 逐层下钻：片段可含 `/`（如 @src/ap）——目录部分逐层解析进子目录，名字部分做前缀过滤；
// 完成目录候选会补尾 `/`，继续输入即下钻一层。
// 立法：候选只限 cwd 内（与权限作用域一致）——目录部分经「词法包含 + realpath 包含」双重校验，
// `..`/绝对路径/盘符/越界符号链接一律不提供联想（对齐权限判定的 realpath 语义）。
export interface PathSuggest {
  /** 候选名的替换起点（名字部分在 input 中的下标）——补全从这里替换到末尾，保留已输入的目录前缀。 */
  replaceStart: number
  entries: { name: string; isDir: boolean }[]
}

const PATH_TOKEN_RE = /(?:^|[\s"'（「])@([^\s@]*)$/
// 候选**全量返回**（目录在前、文件在后，各自字母序）——展示层负责滚动（TUI 滑动窗口 / WebUI 容器滚动），
// 候选截断会让目录多的仓库看不到文件（立法：这里不做任何截断）。
// TUI 渲染窗口高度：仅渲染光标附近的 N 行，↑↓ 时窗口跟随滚动。
export const PATH_SUGGEST_WINDOW = 8
// 目录列表缓存 TTL：连续按键共享一次 readdir（大目录逐键重读会卡）；过期即重读保证新建文件可见。
const CACHE_TTL_MS = 3000

interface CacheEntry {
  at: number
  entries: { name: string; isDir: boolean }[]
}
const dirCache = new Map<string, CacheEntry>()

// cwd 的 realpath 缓存（cwd 会话内不变）——matchPathToken 每次按键会被调用多次（按键/渲染/提交），避免重复 syscall。
let realRootCache: { cwd: string; real: string } | null = null

// 片段的目录部分解析为「cwd 内的真实绝对路径」；越界（词法或 realpath）或目录不存在返回 null。
function resolveDirWithinCwd(cwd: string, dirPart: string): string | null {
  const root = resolve(cwd)
  const abs = dirPart === '' ? root : resolve(root, dirPart.replace(/\\/g, '/'))
  // 词法包含校验：resolve 折叠 .. 后仍须落在 cwd 内（`../`、盘符、根绝对路径在此被拒）。
  const absN = abs.replace(/\\/g, '/')
  const rootN = root.replace(/\\/g, '/')
  if (absN !== rootN && !absN.startsWith(rootN + '/')) return null
  // realpath 包含校验：cwd 内的符号链接/junction 指向 cwd 外时不提供越界候选。
  try {
    if (!realRootCache || realRootCache.cwd !== root) {
      realRootCache = { cwd: root, real: realpathSync(root).replace(/\\/g, '/') }
    }
    const realDir = realpathSync(abs).replace(/\\/g, '/')
    const realRootN = realRootCache.real
    if (realDir !== realRootN && !realDir.startsWith(realRootN + '/')) return null
    return realDir
  } catch {
    return null // 目录不存在/不可达（片段输错中途态）：无候选
  }
}

// readdir + 缓存（TTL）；目录不可读返回 null（不缓存失败——稍后重试）。
function readEntries(dir: string): { name: string; isDir: boolean }[] | null {
  const hit = dirCache.get(dir)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    dirCache.set(dir, { at: Date.now(), entries })
    return entries
  } catch {
    return null
  }
}

// 输入末尾匹配 @token 并给出候选；无命中/无 cwd/越界返回 null。
export function matchPathToken(input: string, cwd: string | undefined): PathSuggest | null {
  if (!cwd) return null
  const m = PATH_TOKEN_RE.exec(input)
  if (!m) return null
  const fragment = m[1]!
  // 片段按最后一个 `/` 拆分：前段是逐层解析的目录部分，后段是候选名前缀（不含 `/`，无越界可能）。
  const slash = fragment.lastIndexOf('/')
  const dirPart = slash >= 0 ? fragment.slice(0, slash) : ''
  const namePart = slash >= 0 ? fragment.slice(slash + 1) : fragment
  // 完整 token 恰好指向已存在的文件 → 补全已终结：文件没有下一层可下钻，弹框关闭。
  //（目录可继续列出子层——带尾 `/` 时 namePart 为空，不进此分支；部分前缀不整除文件名也不进。）
  if (namePart !== '') {
    const whole = resolveDirWithinCwd(cwd, fragment)
    if (whole) {
      try { if (statSync(whole).isFile()) return null } catch { /* 文件已消失 → 照常给候选 */ }
    }
  }
  const dir = resolveDirWithinCwd(cwd, dirPart)
  if (!dir) return null
  const all = readEntries(dir)
  if (!all) return null
  // 隐藏文件不作候选（显式输入 `@.git/` 仍可进入——目录部分不做此过滤）。
  const prefix = namePart.toLowerCase()
  const matched = all.filter((e) => !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
  // 目录在前、文件在后，各自字母序，全量返回不截断。
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1)
  const entries = [
    ...matched.filter((e) => e.isDir).sort(byName),
    ...matched.filter((e) => !e.isDir).sort(byName),
  ]
  // 候选名的替换起点 = 匹配串末尾回退 namePart 长度（保留 '@' 与已输入的目录前缀）。
  return entries.length > 0 ? { replaceStart: m.index + m[0].length - namePart.length, entries } : null
}

// 补全：把 input 中 replaceStart 起的名字部分替换为候选名（目录补一个尾 /，继续输入即下钻）。
export function applyPathCompletion(input: string, replaceStart: number, entry: { name: string; isDir: boolean }): string {
  return input.slice(0, replaceStart) + entry.name + (entry.isDir ? '/' : '')
}
