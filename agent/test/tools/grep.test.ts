import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { GrepTool } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'

let dir = mkdtempSync(join(tmpdir(), 'dogegg-grep-'))
const tool = new GrepTool()
const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal })

afterEach(() => { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), 'dogegg-grep-')) })

describe('grep tool', () => {
  it('reports path:line: content with 1-based line numbers', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1\nneedle here\nconst y = 2')
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    expect(r.content).toBe('a.ts:2: needle here')
  })

  it('handles CRLF line endings without losing matches', async () => {
    writeFileSync(join(dir, 'crlf.txt'), 'one\r\nneedle\r\nthree')
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    expect(r.content).toBe('crlf.txt:2: needle')
  })

  it('skips binary files (NUL probe) and files over 1MB', async () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x64, 0x00, 0x64, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))
    writeFileSync(join(dir, 'text.txt'), 'needle')
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    expect(r.content).toBe('text.txt:1: needle')
  })

  it('glob filter matches full path OR basename (*.ts hits nested src/x.ts)', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'x.ts'), 'needle')
    writeFileSync(join(dir, 'src', 'y.md'), 'needle')
    const r = await tool.execute({ pattern: 'needle', glob: '*.ts' }, ctx()) as { content: string }
    expect(r.content).toBe('src/x.ts:1: needle')
  })

  it('case_insensitive flag', async () => {
    writeFileSync(join(dir, 'f.txt'), 'NEEDLE')
    expect(await tool.execute({ pattern: 'needle' }, ctx())).toMatchObject({ content: '（无命中）' })
    const r = await tool.execute({ pattern: 'needle', case_insensitive: true }, ctx()) as { content: string }
    expect(r.content).toBe('f.txt:1: NEEDLE')
  })

  it('files_with_matches and count modes', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hit\nhit\nmiss')
    writeFileSync(join(dir, 'b.txt'), 'hit')
    const files = await tool.execute({ pattern: 'hit', output_mode: 'files_with_matches' }, ctx()) as { content: string }
    expect(files.content.split('\n')).toEqual(['a.txt', 'b.txt'])
    const counts = await tool.execute({ pattern: 'hit', output_mode: 'count' }, ctx()) as { content: string }
    expect(counts.content.split('\n')).toEqual(['a.txt: 2', 'b.txt: 1'])
  })

  it('invalid regex returns error receipt (model self-corrects, loop continues)', async () => {
    const r = await tool.execute({ pattern: 'a(' }, ctx())
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('无效的正则表达式')
  })

  it('searches a single file when path points at a file', async () => {
    writeFileSync(join(dir, 'one.txt'), 'needle\nnope\nneedle')
    const r = await tool.execute({ pattern: 'needle', path: 'one.txt' }, ctx()) as { content: string }
    expect(r.content.split('\n')).toEqual(['one.txt:1: needle', 'one.txt:3: needle'])
  })

  it('path 指向具体文件时 glob 不参与过滤（显式点名即授权）', async () => {
    writeFileSync(join(dir, 'one.ts'), 'needle')
    // 回归点：单文件模式 rel='' 恒不过 globRe.test('') → 点名文件被误过滤成无命中。
    const r = await tool.execute({ pattern: 'needle', path: 'one.ts', glob: '*.ts' }, ctx()) as { content: string }
    expect(r.content).toBe('one.ts:1: needle')
  })

  it('gitignore 坐标系：path 传子目录时锚定规则双向不失真', async () => {
    // 回归点：规则按会话 cwd 根编译，walker 产出的是相对子根的路径——
    // `docs/internal.md` 在子根坐标下变成 internal.md（被搜出）、`/README.md` 误杀 docs/README.md。
    writeFileSync(join(dir, '.gitignore'), 'docs/internal.md\n/top.md\n')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'internal.md'), 'needle')
    writeFileSync(join(dir, 'docs', 'README.md'), 'needle')
    writeFileSync(join(dir, 'top.md'), 'needle')
    const sub = await tool.execute({ pattern: 'needle', path: 'docs' }, ctx()) as { content: string }
    expect(sub.content).toBe('README.md:1: needle')
    // 全根扫描（root===cwd，两坐标系重合）行为不变：internal.md 与锚定的 top.md 都被忽略。
    const full = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    expect(full.content).toBe('docs/README.md:1: needle')
  })

  it('per-file cap 20 with unshown count note', async () => {
    // 23 行命中 → 展示 20 行 + 一条补数说明（还有 3 处）。
    writeFileSync(join(dir, 'dense.txt'), Array.from({ length: 23 }, (_, i) => `needle ${i}`).join('\n'))
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    const lines = r.content.split('\n')
    expect(lines.length).toBe(21)
    expect(lines[20]).toBe('dense.txt（该文件还有 3 处未显示）')
  })

  it('total cap 100 across files with narrowing note', async () => {
    for (let f = 0; f < 12; f++) writeFileSync(join(dir, `f${f}.txt`), Array.from({ length: 10 }, () => 'needle').join('\n'))
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    const lines = r.content.split('\n')
    expect(lines.length).toBe(101) // 100 行命中 + 1 条截断说明
    expect(lines[100]).toContain('输出已截断')
  })

  it('long lines truncated at 500 chars with ellipsis', async () => {
    writeFileSync(join(dir, 'long.txt'), 'needle' + 'x'.repeat(600))
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    const row = (r as { content: string }).content
    expect(row.startsWith('long.txt:1: needle')).toBe(true)
    expect(row.endsWith('…')).toBe(true)
    expect(row.length).toBeLessThan(520)
  })

  it('prunes ignored directories', async () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'needle')
    writeFileSync(join(dir, 'app.js'), 'needle')
    const r = await tool.execute({ pattern: 'needle' }, ctx()) as { content: string }
    expect(r.content).toBe('app.js:1: needle')
  })
})
