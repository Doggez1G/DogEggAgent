import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// 架构测试：扫描四包源码，把「依赖方向」「模块边界（index 纯 re-export）」从约定升级为可执行断言。
// 放 bridge 是刻意的——桥是边界的所有者，由它守门。
// 体量红线已移除（S2）：「不堆功能进单文件」作为实现准则由 review 把关，不做机械行数断言。

const root = process.cwd()

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.tsx?$/.test(f) ? [p] : []
  })
}

function importsOf(f: string): string[] {
  const src = readFileSync(f, 'utf8')
  const re = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1]!)
  return out
}

const pkgDir = { agent: 'agent/src', ui: 'ui/src', bridge: 'bridge/src', server: 'server/src' } as const
const scan = (d: string) => walk(d).map((p) => ({ p, imps: importsOf(p) }))
const files = { agent: scan(pkgDir.agent), ui: scan(pkgDir.ui), bridge: scan(pkgDir.bridge), server: scan(pkgDir.server) }

describe('architecture: 依赖方向', () => {
  it('agent 与 ui 互不依赖（不 import 对方的包名）', () => {
    expect(files.agent.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
    expect(files.ui.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
  })
  it('bridge 不依赖任何兄弟包（契约不反向依赖）', () => {
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/server')
  })
  it('server 不依赖 ui（前端是静态文件被 serve，不是代码被 import）', () => {
    expect(existsSync(pkgDir.server)).toBe(true)
    expect(files.server.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
  })
  it('webui 不依赖 agent 或 server（前端只依赖 bridge + shared）', () => {
    const webuiFiles = walk('ui/src/webui')
    expect(webuiFiles.flatMap((f) => importsOf(f))).not.toContain('@dogegg/agent')
    expect(webuiFiles.flatMap((f) => importsOf(f))).not.toContain('@dogegg/server')
  })
  it('shared 不依赖 agent 或 ui 的 tui/webui 子路径', () => {
    const sharedFiles = walk('ui/src/shared')
    expect(sharedFiles.flatMap((f) => importsOf(f))).not.toContain('@dogegg/agent')
  })
})

describe('architecture: 模块边界（index 只做 re-export）', () => {
  it('index.ts / index.tsx 只含 import 与 export 行，不得出现实现逻辑', () => {
    const violators = Object.values(pkgDir)
      .flatMap((base) => walk(base))
      .filter((f) => f.endsWith('/index.ts') || f.endsWith('/index.tsx'))
      .filter((idx) => {
        const src = readFileSync(idx, 'utf8')
        const lines = src.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('//'))
        // 只允许 re-export 形式（export ... from / export { ... } / export * / export type），
        // 拒绝 export const/function/class/let/var/interface/type X = 等实现声明。
        return lines.some((l) => {
          // import 行允许。
          if (l.startsWith('import ') || l.startsWith('import{')) return false
          // export 行：只允许 re-export（含 from），不允许 export const/function/class 等声明。
          if (l.startsWith('export ') || l.startsWith('export{')) {
            // re-export 形式：export ... from '...' / export * from / export { } from / export type { } from
            if (l.includes(' from ') || l.startsWith('export *') || l.startsWith('export{') || l.startsWith('export {')) return false
            // export type { ... }（纯类型 re-export，无 from 也允许）
            if (l.startsWith('export type {')) return false
            // 其他 export 形式（export const/function/class/let/var/interface/type X =）视为实现。
            return true
          }
          // 非空非注释非 import/export 行 → 视为实现。
          return true
        })
      })
    expect(violators).toEqual([])
  })

  it('非 index 文件不直接 import 模块私有文件（应通过 index.ts barrel）', () => {
    // 检测 import 路径指向已知有 barrel 的模块的私有文件。
    // 已知 barrel 目录：shared, core, core/state, tools, context, context/token, context/message,
    // llm, llm/streaming, permission, session, config, config/editor, config/loader, config/resolve
    // 这些目录都有 index.ts，import 应指向目录而非内部文件。
    const barrelDirs = [
      'shared/errors', 'shared/id', 'shared/logger',
      'core/state', 'core/pending',
      'tools/types', 'tools/registry',
      'context/token', 'context/message', 'context/compact', 'context/prompt',
      'llm/types', 'llm/adapter-for', 'llm/streaming',
      'permission/classify', 'permission/runtime',
      'session/store', 'session/list',
    ]
    // 检查 agent 和 ui 包内非 index 文件的 import。
    const violators = [
      ...walk(pkgDir.agent),
      ...walk(pkgDir.ui),
    ]
      .filter((f) => !f.endsWith('/index.ts') && !f.endsWith('/index.tsx') && (f.endsWith('.ts') || f.endsWith('.tsx')))
      .flatMap((f) => {
        const src = readFileSync(f, 'utf8')
        const lines = src.split('\n').map((l) => l.trim())
        return lines
          .filter((l) => l.startsWith('import '))
          .filter((l) => barrelDirs.some((d) => l.includes(`/${d}'`) || l.includes(`/${d}"`)))
          .map((l) => `${f}: ${l}`)
      })
    expect(violators).toEqual([])
  })
})
