import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { walkFiles, IGNORED_DIRS, isBinaryFile } from '../../src/tools/traverse'

// 每个用例独立临时目录（walker 会跨目录复用状态？不会——但独立目录避免用例间文件串扰）。
let dir: string | null = null
function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'dogegg-traverse-'))
  return dir
}
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

async function collect(root: string): Promise<string[]> {
  const out: string[] = []
  for await (const rel of walkFiles(root)) out.push(rel)
  return out
}

describe('walkFiles', () => {
  it('yields posix relative paths recursively', async () => {
    const d = fresh()
    writeFileSync(join(d, 'a.txt'), 'x')
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'b.txt'), 'x')
    const files = await collect(d)
    expect(files.sort()).toEqual(['a.txt', 'sub/b.txt']) // 正斜杠，相对路径
  })

  it('prunes ignored directories at any depth', async () => {
    const d = fresh()
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(d, 'node_modules', 'pkg', 'index.js'), 'x')
    mkdirSync(join(d, 'src', 'node_modules'), { recursive: true }) // 任意深度都剪
    writeFileSync(join(d, 'src', 'node_modules', 'x.js'), 'x')
    writeFileSync(join(d, 'src', 'keep.ts'), 'x')
    const files = await collect(d)
    expect(files).toEqual(['src/keep.ts'])
  })

  it('does not prune hidden dirs unless listed (e.g. .github)', async () => {
    const d = fresh()
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'x')
    const files = await collect(d)
    expect(files).toEqual(['.github/workflows/ci.yml']) // 黑名单只有 .git，不含 .github
  })

  it('skips symlinks (no cycles, no escaping the root)', async () => {
    const d = fresh()
    writeFileSync(join(d, 'real.txt'), 'x')
    try { symlinkSync('real.txt', join(d, 'link.txt')) } catch { return } // Windows 非 privileged 可能拒绝建 symlink
    const files = await collect(d)
    expect(files).toEqual(['real.txt'])
  })
})

describe('ignore', () => {
  it('IGNORED_DIRS contains traversal blackholes', () => {
    expect(IGNORED_DIRS.has('node_modules')).toBe(true)
    expect(IGNORED_DIRS.has('.git')).toBe(true)
    expect(IGNORED_DIRS.has('.github')).toBe(false)
  })

  it('isBinaryFile detects NUL byte in head', () => {
    expect(isBinaryFile(new Uint8Array([0x64, 0x00, 0x65]))).toBe(true)
    expect(isBinaryFile(new Uint8Array([0x64, 0x65, 0x0a]))).toBe(false)
    expect(isBinaryFile(new Uint8Array([]))).toBe(false)
  })
})
