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

  it('跨域 import 必须走域门面（../X 一层，禁止 ../X/深路径）', () => {
    // 纵切重构立法：分类文件夹的 index 仅供域内组装，跨域只允许一层路径。
    // 例：允许 '../config'，禁止 '../config/editor'（后者绕过域门面）。
    const violators = walk(pkgDir.agent)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('index.ts'))
      .flatMap((f) => {
        const domain = domainOf(f)
        return importsOf(f)
          .filter((imp) => imp.startsWith('../') && !imp.startsWith('../..'))
          .filter((imp) => {
            const segs = imp.split('/')
            if (segs.length <= 2) return false // '../ctx'、'../tools' 一层——合法
            return segs[1] !== domain // 深路径且跨域 → 违规
          })
          .map((imp) => `${f}: ${imp}`)
      })
    expect(violators).toEqual([])
  })
})

// ── agent 子域定位（纵切立法用）─────────────────────────────────────────────
function domainOf(p: string): string {
  const rel = p.slice(pkgDir.agent.length + 1).split(/[/\\]/).join('/')
  const segs = rel.split('/')
  return segs.length === 1 ? 'ROOT' : segs[0]!
}

// 相对 import 解析为目标域。单段 rel 二义：根文件（agent/ctx/index）→ ROOT，否则是域 barrel → 该域。
function resolveTarget(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const rel = join(fromFile, '..', spec).slice(pkgDir.agent.length + 1).split(/[/\\]/).join('/')
  const segs = rel.split('/')
  if (segs.length === 1) {
    return ['agent', 'ctx', 'index'].includes(segs[0]!) ? 'ROOT' : segs[0]!
  }
  return segs[0]!
}

describe('architecture: agent 子域矩阵（纵切立法，2026-09-07 spec §6）', () => {
  // 允许依赖矩阵。改矩阵 = 显式设计决策：同时改这里与 spec。
  // ROOT = agent/src 根文件（agent.ts 门面 / ctx.ts 可变状态持有者 / index.ts 包出口）。
  const ALLOWED: Record<string, string[]> = {
    turn: ['session', 'llm', 'tools', 'context', 'permission', 'shared', 'ROOT'],
    session: ['shared', 'ROOT'],
    config: ['ROOT'],
    tools: [],
    llm: [],
    context: ['tools'],
    permission: [],
    shared: [],
  }

  it('agent 域间依赖只允许矩阵内的边（能力模块互不依赖，无回穿）', () => {
    const violators = walk(pkgDir.agent)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('index.ts'))
      .flatMap((f) => {
        const domain = domainOf(f)
        if (domain === 'ROOT') return [] // 根（门面与 ctx）依赖一切，不受矩阵约束
        return importsOf(f)
          .map((imp) => resolveTarget(f, imp))
          .filter((t): t is string => t !== null)
          .filter((t) => t !== domain)
          .filter((t) => !(ALLOWED[domain] ?? []).includes(t))
          .map((t) => `${domain} -> ${t} (${f})`)
      })
    expect(violators).toEqual([])
  })

  it('跨域 import 必须走域门面（../X 一层，禁止 ../X/深路径）', () => {
    // 纵切重构立法：分类文件夹的 index 仅供域内组装，跨域只允许一层路径。
    // 例：允许 '../config'，禁止 '../config/editor'（后者绕过域门面）。
    const violators = walk(pkgDir.agent)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('index.ts'))
      .flatMap((f) => {
        const domain = domainOf(f)
        return importsOf(f)
          .filter((imp) => imp.startsWith('../') && !imp.startsWith('../..'))
          .filter((imp) => {
            const segs = imp.split('/')
            if (segs.length <= 2) return false // '../ctx'、'../tools' 一层——合法
            return segs[1] !== domain // 深路径且跨域 → 违规
          })
          .map((imp) => `${f}: ${imp}`)
      })
    expect(violators).toEqual([])
  })
})


describe('architecture: 前端边界（UI 批次立法）', () => {
  it('tui 与 webui 互不依赖（两个前端各自独立）', () => {
    const tuiImports = walk('ui/src/tui').flatMap((f) => importsOf(f))
    const webuiImports = walk('ui/src/webui').flatMap((f) => importsOf(f))
    expect(tuiImports.some((i) => i.includes('/webui') || i.includes('\webui'))).toBe(false)
    expect(webuiImports.some((i) => i.includes('/tui') || i.includes('\tui'))).toBe(false)
  })

  it('features 视图与组件不得 import 装配层 app/', () => {
    const offenders = ['ui/src/tui/features', 'ui/src/webui/features', 'ui/src/tui/components', 'ui/src/webui/components']
      .flatMap((dir) => walk(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')))
      // 样式共享（.module.css）不算逻辑依赖——立法管的是代码装配层。
      .filter((f) => importsOf(f).filter((i) => !i.endsWith('.css')).some((i) => i.includes('/app/') || i.startsWith('./app')))
      .map((f) => f)
    expect(offenders).toEqual([])
  })
})
