import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { matchPathToken, applyPathCompletion } from '../../src/tui/features/input'

// @path 联想单测：逐层下钻、前缀过滤、cwd 越界拒绝（词法 + realpath 双重校验）与补全拼接。
let dir: string | null = null
function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'dogegg-at-'))
  return dir
}
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

function names(ps: ReturnType<typeof matchPathToken>): string[] {
  return ps ? ps.entries.map((e) => e.name) : []
}

describe('matchPathToken（@path 逐层联想）', () => {
  it('顶层候选：目录优先 + 隐藏文件不作候选（候选名不含尾 /，渲染/补全时再加）', () => {
    const d = fresh()
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'zeta.txt'), 'x')
    writeFileSync(join(d, 'alpha.txt'), 'x')
    writeFileSync(join(d, '.hidden'), 'x')
    const ps = matchPathToken('@', d)
    expect(names(ps)).toEqual(['sub', 'alpha.txt', 'zeta.txt'])
    expect(ps!.replaceStart).toBe(1)
  })

  it('前缀过滤：片段匹配候选名（大小写不敏感）', () => {
    const d = fresh()
    writeFileSync(join(d, 'README.md'), 'x')
    writeFileSync(join(d, 'roadmap.md'), 'x')
    writeFileSync(join(d, 'src'), 'x')
    expect(names(matchPathToken('@re', d))).toEqual(['README.md'])
  })

  it('逐层下钻：@src/ap 列出 src 内匹配候选', () => {
    const d = fresh()
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'app.ts'), 'x')
    writeFileSync(join(d, 'src', 'util.ts'), 'x')
    writeFileSync(join(d, 'outside.ts'), 'x')
    const ps = matchPathToken('@src/ap', d)
    expect(names(ps)).toEqual(['app.ts'])
    // replaceStart 指向名字部分（'@src/' 之后）——补全只替换名字，保留已输入的目录前缀。
    expect(ps!.replaceStart).toBe(5)
  })

  it('目录片段以 / 结尾：列出该目录全部（非隐藏）候选', () => {
    const d = fresh()
    mkdirSync(join(d, 'docs'))
    writeFileSync(join(d, 'docs', 'a.md'), 'x')
    writeFileSync(join(d, 'docs', '.secret'), 'x')
    expect(names(matchPathToken('@docs/', d))).toEqual(['a.md'])
  })

  it('越界拒绝：.. 上跳 / 盘符绝对路径 → 无候选', () => {
    const d = fresh()
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'a.ts'), 'x')
    expect(matchPathToken('@../', d)).toBeNull()
    expect(matchPathToken('@src/../../', d)).toBeNull()
    expect(matchPathToken('@C:/Windows/', d)).toBeNull()
  })

  it('不存在的子目录 / cwd 缺失 → 无候选', () => {
    const d = fresh()
    expect(matchPathToken('@nope/', d)).toBeNull()
    expect(matchPathToken('@a', undefined)).toBeNull()
  })

  it('候选全量返回不截断（展示层滚动，此处不设上限）', () => {
    const d = fresh()
    for (let i = 0; i < 12; i++) writeFileSync(join(d, `file${i}.txt`), 'x')
    expect(names(matchPathToken('@file', d))).toHaveLength(12)
  })

  it('目录在前文件在后、各自字母序、全量返回', () => {
    const d = fresh()
    for (let i = 0; i < 12; i++) mkdirSync(join(d, `folder${i}`))
    for (let i = 0; i < 3; i++) writeFileSync(join(d, `file${i}.txt`), 'x')
    const ps = matchPathToken('@f', d)!
    expect(ps.entries).toHaveLength(15)
    expect(ps.entries.filter((e) => e.isDir)).toHaveLength(12)
    expect(ps.entries.filter((e) => !e.isDir)).toHaveLength(3)
    expect(ps.entries[0]!.isDir).toBe(true)
    expect(ps.entries[ps.entries.length - 1]!.isDir).toBe(false)
  })

  it('token 恰好指向已存在文件 → 无候选（补全终结，弹框自动关闭）', () => {
    const d = fresh()
    writeFileSync(join(d, 'done.txt'), 'x')
    mkdirSync(join(d, 'sub'))
    // 完整文件名 → 关闭；部分前缀 → 照常给候选；目录名 → 照常给候选（可继续下钻）。
    expect(matchPathToken('@done.txt', d)).toBeNull()
    expect(names(matchPathToken('@done', d))).toEqual(['done.txt'])
    expect(names(matchPathToken('@sub', d))).toEqual(['sub'])
  })

  it('applyPathCompletion：只替换名字部分（目录补尾 /，文件直接拼接），保留目录前缀', () => {
    expect(applyPathCompletion('看下@sr', 3, { name: 'src', isDir: true })).toBe('看下@src/')
    expect(applyPathCompletion('看下@src/ut', 7, { name: 'util.ts', isDir: false })).toBe('看下@src/util.ts')
  })
})
