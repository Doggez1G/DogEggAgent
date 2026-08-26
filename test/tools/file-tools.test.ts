import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { readFileTool } from '../../src/tools/read_file'
import { writeFileTool } from '../../src/tools/write_file'
import { editFileTool } from '../../src/tools/edit_file'
import type { ToolContext } from '../../src/tools/types'

const dir = mkdtempSync(join(tmpdir(), 'dogegg-tools-'))
const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal }

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

  it('edit_file replaces first occurrence', async () => {
    writeFileSync(join(dir, 'c.txt'), 'foo foo')
    await editFileTool.execute({ path: 'c.txt', old_string: 'foo', new_string: 'bar' }, ctx)
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('bar foo')
  })
})