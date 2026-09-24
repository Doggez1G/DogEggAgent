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

  it('edit_file 空 old_string → error 回执且文件不变（防文件头静默插入）', async () => {
    // 回归点：空串 indexOf 恒为 0，replace 会把 new_string 静默插到文件头。
    writeFileSync(join(dir, 'e.txt'), 'keep me')
    const r = await editFileTool.execute({ path: 'e.txt', old_string: '', new_string: 'HACK' }, ctx)
    expect(r).toMatchObject({ error: 'old_string 不能为空' })
    expect(readFileSync(join(dir, 'e.txt'), 'utf8')).toBe('keep me')
    // schema 层第一道关口：min(1) 校验同样拦截空串
    expect(() => editFileTool.schema.parse({ path: 'e.txt', old_string: '', new_string: 'x' })).toThrow()
  })

  it('edit_file new_string 为空 = 删除语义（合法边界）', async () => {
    writeFileSync(join(dir, 'f.txt'), 'abcHEADdef')
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'HEAD', new_string: '' }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('abcdef')
  })

  it('read_file 超过 1MB → error 回执并指引 grep；正常文件不受影响', async () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1)) // 恰好越界
    const r = await readFileTool.execute({ path: 'big.txt' }, ctx)
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('文件超过 1MB')
    expect((r as { error: string }).error).toContain('grep')
    writeFileSync(join(dir, 'ok.txt'), 'normal')
    expect(await readFileTool.execute({ path: 'ok.txt' }, ctx)).toMatchObject({ content: 'normal' })
  })
})