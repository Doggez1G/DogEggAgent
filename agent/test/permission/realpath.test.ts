import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { PermissionManager } from '../../src/permission'
import type { PermissionConfig } from '@dogegg/bridge'

// realpath 安全测试：junction（Windows 免管理员）构造「cwd 内链接 → cwd 外真实文件」的逃逸场景。
let proj: string | null = null
let outside: string | null = null

function setup(): { proj: string; cfg: PermissionConfig } {
  proj = mkdtempSync(join(tmpdir(), 'dogegg-proj-'))
  outside = mkdtempSync(join(tmpdir(), 'dogegg-out-'))
  writeFileSync(join(proj, 'normal.txt'), 'x')
  return { proj, cfg: { allow: { read_file: ['./**'] }, reject: {}, ask: {} } }
}

afterEach(() => {
  if (proj) rmSync(proj, { recursive: true, force: true })
  if (outside) rmSync(outside, { recursive: true, force: true })
  proj = outside = null
})

describe('PermissionManager realpath（符号链接逃逸防护）', () => {
  it('cwd 内普通文件：realpath 与词法一致，判定不变', () => {
    const { proj, cfg } = setup()
    const pm = new PermissionManager(cfg)
    expect(pm.classify('read_file', { path: 'normal.txt' }, proj)).toBe('allow')
  })

  it('cwd 内链接指向 cwd 外：realpath 越界 → 失配落 ask（词法匹配会被骗）', () => {
    const { proj, cfg } = setup()
    let linkOk = true
    try {
      symlinkSync(outside!, join(proj!, 'link'), 'junction')
    } catch {
      return // 环境不支持 symlink 时跳过（CI 特权账号可用）
    }
    const pm = new PermissionManager(cfg)
    expect(pm.classify('read_file', { path: 'link/secret.txt' }, proj)).toBe('ask')
  })

  it('新建文件的写入场景：父目录 realpath + 文件名回退', () => {
    const { proj, cfg } = setup()
    mkdirSync(join(proj!, 'docs'))
    const pm = new PermissionManager({ allow: { read_file: ['./docs/**'] }, reject: {}, ask: {} })
    // docs/new.txt 不存在——父目录 docs 是真实目录，realpath(dirname) 命中
    expect(pm.classify('read_file', { path: 'docs/new.txt' }, proj)).toBe('allow')
  })
})
