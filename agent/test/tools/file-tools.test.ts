import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ReadFileTool, WriteFileTool, EditFileTool } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-tools-'))
const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal }
const readFileTool = new ReadFileTool()
const writeFileTool = new WriteFileTool()
const editFileTool = new EditFileTool()

describe('file tools', () => {
  it('read_file returns content', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx)
    expect(r).toMatchObject({ content: 'hi' })
  })

  it('write_file creates and overwrites', async () => {
    await writeFileTool.execute({ path: 'b.txt', content: 'x' }, ctx)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('x')
  })

  it('edit_file replaces first occurrence with line anchor in receipt', async () => {
    writeFileSync(join(dir, 'c.txt'), 'foo foo')
    const r = await editFileTool.execute({ path: 'c.txt', old_string: 'foo', new_string: 'bar' }, ctx)
    // 回执锚点（原第 N 行起）供模型定位后续编辑 + UI diff 标真实行号。
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('bar foo')
  })

  it('edit_file anchor points at the old_string start line', async () => {
    writeFileSync(join(dir, 'd.txt'), 'l1\nl2\nl3')
    const r = await editFileTool.execute({ path: 'd.txt', old_string: 'l2', new_string: 'L2' }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 2 行起）' })
  })
})