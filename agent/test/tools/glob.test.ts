import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { GlobTool } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'

let dir = mkdtempSync(join(tmpdir(), 'dogegg-glob-'))
const tool = new GlobTool()
const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal })

afterEach(() => { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), 'dogegg-glob-')) })

function seed(): void {
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(join(dir, 'a.ts'), 'x')
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  writeFileSync(join(dir, 'src', 'b.ts'), 'x')
  writeFileSync(join(dir, 'src', 'deep', 'c.ts'), 'x')
  mkdirSync(join(dir, 'node_modules', 'p'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'p', 'i.ts'), 'x') // 黑名单：不出现
}

describe('glob tool', () => {
  it('matches across segments with **, sorted output', async () => {
    seed()
    const r = await tool.execute({ pattern: '**/*.ts' }, ctx()) as { content: string }
    expect(r.content.split('\n')).toEqual(['a.ts', 'src/b.ts', 'src/deep/c.ts'])
  })

  it('single * stays within one segment', async () => {
    seed()
    const r = await tool.execute({ pattern: '*.ts' }, ctx()) as { content: string }
    expect(r.content).toBe('a.ts')
  })

  it('respects optional path sub-root', async () => {
    seed()
    const r = await tool.execute({ pattern: '**/*.ts', path: 'src' }, ctx()) as { content: string }
    expect(r.content.split('\n')).toEqual(['b.ts', 'deep/c.ts']) // 相对子根
  })

  it('gitignore 坐标系：path 传子目录时锚定规则双向不失真', async () => {
    // 回归点：规则按会话 cwd 根编译，walker 产出的是相对子根的路径——
    // `docs/internal.md` 在子根坐标下变成 internal.md（被搜出）、`/README.md` 误杀 docs/README.md。
    writeFileSync(join(dir, '.gitignore'), 'docs/internal.md\n/top.md\n')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'internal.md'), 'x')
    writeFileSync(join(dir, 'docs', 'README.md'), 'x')
    writeFileSync(join(dir, 'top.md'), 'x')
    const sub = await tool.execute({ pattern: '**/*.md', path: 'docs' }, ctx()) as { content: string }
    expect(sub.content).toBe('README.md')
    // 全根扫描（root===cwd，两坐标系重合）行为不变：internal.md 与锚定的 top.md 都被忽略。
    const full = await tool.execute({ pattern: '**/*.md' }, ctx()) as { content: string }
    expect(full.content).toBe('docs/README.md')
  })

  it('caps at 100 with a narrowing hint', async () => {
    for (let i = 0; i < 103; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const r = await tool.execute({ pattern: '*.txt' }, ctx()) as { content: string }
    const lines = r.content.split('\n')
    expect(lines.length).toBe(101)
    expect(lines[100]).toBe('（仅显示前 100 个命中，请收窄 pattern）')
  })

  it('no match says so; missing root errors', async () => {
    const r = await tool.execute({ pattern: '*.nope' }, ctx()) as { content: string }
    expect(r.content).toBe('（无匹配文件）')
    const e = await tool.execute({ pattern: '*.ts', path: 'nope-dir' }, ctx())
    expect(e).toHaveProperty('error')
  })
})
