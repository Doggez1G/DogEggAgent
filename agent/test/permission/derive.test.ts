import { describe, it, expect } from 'vitest'
import { deriveAlwaysScope } from '../../src/permission/derive'

const cwd = 'D:/proj'

describe('deriveAlwaysScope（范围提升的模式推导）', () => {
  it('shell：首词前缀；无后续参数时精确', () => {
    expect(deriveAlwaysScope('shell', { command: 'git status' }, cwd)).toBe('git *')
    expect(deriveAlwaysScope('shell', { command: 'git  commit -m "x"' }, cwd)).toBe('git *') // 多空白容错
    expect(deriveAlwaysScope('shell', { command: 'ls' }, cwd)).toBe('ls')
    expect(deriveAlwaysScope('shell', { command: '' }, cwd)).toBeUndefined()
  })

  it('path：所在目录级；根部文件回退精确', () => {
    expect(deriveAlwaysScope('read_file', { path: 'docs/guide.md' }, cwd)).toBe('./docs/**')
    expect(deriveAlwaysScope('edit_file', { path: 'D:/proj/docs/guide.md' }, cwd)).toBe('./docs/**') // 绝对入参同判定
    expect(deriveAlwaysScope('write_file', { path: 'guide.md' }, cwd)).toBe('./guide.md') // 根部文件 → 精确（防 ./** 放行全项目）
  })

  it('保守边界：cwd 本身 / cwd 外 / 缺参数 → undefined（弹层退回三档）', () => {
    expect(deriveAlwaysScope('read_file', { path: '.' }, cwd)).toBeUndefined()
    expect(deriveAlwaysScope('read_file', { path: '../x' }, cwd)).toBeUndefined()
    expect(deriveAlwaysScope('read_file', {}, cwd)).toBeUndefined()
  })
})
