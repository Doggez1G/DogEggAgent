import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { LsTool } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'

let dir = mkdtempSync(join(tmpdir(), 'dogegg-ls-'))
const tool = new LsTool()
const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal })

afterEach(() => { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), 'dogegg-ls-')) })

describe('ls tool', () => {
  it('lists dirs first (with / suffix) then files with sizes', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), 'x'.repeat(2048))
    const r = await tool.execute({ path: '.' }, ctx())
    const lines = (r as { content: string }).content.split('\n')
    expect(lines[0]).toBe('src/')
    expect(lines[1]).toMatch(/^package\.json {2}2\.0 KB$/)
  })

  it('shows hidden files (agent needs .github/.gitignore)', async () => {
    writeFileSync(join(dir, '.gitignore'), 'x')
    const r = await tool.execute({ path: '.' }, ctx())
    expect((r as { content: string }).content).toContain('.gitignore')
  })

  it('caps entries at 500 with a truncation note', async () => {
    for (let i = 0; i < 505; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const r = await tool.execute({ path: '.' }, ctx())
    const lines = (r as { content: string }).content.split('\n')
    expect(lines.length).toBe(501)
    expect(lines[500]).toBe('（仅显示前 500 项，共 505 项）')
  })

  it('returns error for missing path or file target', async () => {
    const missing = await tool.execute({ path: 'nope' }, ctx())
    expect(missing).toHaveProperty('error')
    writeFileSync(join(dir, 'file.txt'), 'x')
    const notDir = await tool.execute({ path: 'file.txt' }, ctx())
    expect(notDir).toHaveProperty('error')
  })

  it('empty dir says so', async () => {
    const r = await tool.execute({ path: '.' }, ctx())
    expect(r).toMatchObject({ content: '（空目录）' })
  })
})
