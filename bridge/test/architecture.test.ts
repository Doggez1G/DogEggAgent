import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// 架构测试：扫描三包源码，把「依赖方向」「模块边界（index 纯 re-export）」从约定升级为可执行断言。
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

const pkgDir = { agent: 'agent/src', ui: 'ui/src', bridge: 'bridge/src' } as const
const scan = (d: string) => walk(d).map((p) => ({ p, imps: importsOf(p) }))
const files = { agent: scan(pkgDir.agent), ui: scan(pkgDir.ui), bridge: scan(pkgDir.bridge) }

describe('architecture: 依赖方向', () => {
  it('agent 与 ui 互不依赖（不 import 对方的包名）', () => {
    expect(files.agent.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
    expect(files.ui.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
  })
  it('bridge 不依赖任何兄弟包（契约不反向依赖）', () => {
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/agent')
    expect(files.bridge.flatMap((f) => f.imps)).not.toContain('@dogegg/ui')
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
})
