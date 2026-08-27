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
        // 允许 import / export / re-export；出现其它声明（const/function/class/interface 等）即视为塞了实现。
        return lines.some((l) => !l.startsWith('import ') && !l.startsWith('export ') && !l.startsWith('import{') && !l.startsWith('export{'))
      })
    expect(violators).toEqual([])
  })
})
