import { describe, it, expect } from 'vitest'
import { formatToolArgs, formatToolResult, formatToolTitle, formatToolBody } from '../../src/shared/tool-display'

// 工具展示格式化单测——TUI/WebUI 共用的唯一出处，文案与 diff 语义在此固化。

describe('formatToolArgs', () => {
  it('shell：命令本体加 $ 前缀', () => {
    expect(formatToolArgs('shell', { command: 'npm test' })).toBe('$ npm test')
  })
  it('read_file：路径', () => {
    expect(formatToolArgs('read_file', { path: 'src/index.ts' })).toBe('src/index.ts')
  })
  it('edit_file：路径 + diffstat（修剪公共首尾行）', () => {
    expect(formatToolArgs('edit_file', { path: 'a.ts', old_string: 'a\nb\nc', new_string: 'a\nX\nc' })).toBe('a.ts +1 -1')
  })
  it('edit_file：无公共行时全量统计', () => {
    expect(formatToolArgs('edit_file', { path: 'a.ts', old_string: 'x\ny', new_string: 'p\nq\nr' })).toBe('a.ts +3 -2')
  })
  it('write_file：路径 + 写入行数', () => {
    expect(formatToolArgs('write_file', { path: 'new.ts', content: 'a\nb\nc' })).toBe('new.ts +3')
  })
  it('未知工具：key=value 兜底（比原始 JSON 少符号噪音）', () => {
    expect(formatToolArgs('custom', { target: 'x.ts', limit: 5 })).toBe('target=x.ts limit=5')
  })
  it('参数缺失：不产生悬挂分隔符', () => {
    expect(formatToolArgs('read_file', {})).toBe('')
    expect(formatToolArgs('custom', {})).toBe('')
  })
})

describe('formatToolResult', () => {
  it('running（无输出无错误）返回 null——头行不显示结果段', () => {
    expect(formatToolResult('shell')).toBeNull()
  })
  it('shell / read_file 量化行数', () => {
    expect(formatToolResult('shell', 'a\nb\nc')).toBe('3 行输出')
    expect(formatToolResult('read_file', 'a\nb')).toBe('2 行')
  })
  it('其它工具完成', () => {
    expect(formatToolResult('edit_file', '已成功编辑文件 a.ts')).toBe('完成')
  })
  it('denied → 已拒绝；其它错误 → ✕ 原因', () => {
    expect(formatToolResult('shell', 'denied', 'denied')).toBe('已拒绝')
    expect(formatToolResult('shell', '', '参数校验失败')).toBe('✕ 参数校验失败')
  })
})

describe('formatToolTitle', () => {
  it('name + 参数段 + 结果段', () => {
    expect(formatToolTitle('shell', { command: 'ls' }, 'a\nb')).toBe('shell $ ls · 2 行输出')
  })
  it('running 无结果段', () => {
    expect(formatToolTitle('read_file', { path: 'a.ts' })).toBe('read_file a.ts')
  })
  it('参数为空时不产生多余空格', () => {
    expect(formatToolTitle('custom', {})).toBe('custom')
  })
})

describe('formatToolBody', () => {
  it('shell：命令行 + 输出原文', () => {
    expect(formatToolBody('shell', { command: 'ls' }, 'a\nb')).toEqual([
      { text: '$ ls', kind: 'plain' },
      { text: 'a', kind: 'plain' },
      { text: 'b', kind: 'plain' },
    ])
  })
  it('edit_file：- 旧行 / + 新行，公共首尾行保留为上下文', () => {
    expect(formatToolBody('edit_file', { old_string: 'a\nb\nc\nd', new_string: 'a\nX\nd' })).toEqual([
      { text: '  a', kind: 'plain' },
      { text: '- b', kind: 'del' },
      { text: '- c', kind: 'del' },
      { text: '+ X', kind: 'add' },
      { text: '  d', kind: 'plain' },
    ])
  })
  it('write_file：内容全部标记为 add', () => {
    expect(formatToolBody('write_file', { content: 'a\nb' })).toEqual([
      { text: '+ a', kind: 'add' },
      { text: '+ b', kind: 'add' },
    ])
  })
  it('错误：✕ 行在前，部分输出随后（如 shell 超时前已产生的输出）', () => {
    const body = formatToolBody('shell', { command: 'ls' }, 'partial', '命令超过 120s 未结束')
    expect(body[0]).toEqual({ text: '✕ 命令超过 120s 未结束', kind: 'plain' })
    expect(body[1]).toEqual({ text: 'partial', kind: 'plain' })
  })
  it('空输出兜底（无输出）', () => {
    expect(formatToolBody('read_file', { path: 'a' }, '')).toEqual([{ text: '（无输出）', kind: 'plain' }])
  })
  it('超长输出封顶 200 行并标注剩余', () => {
    const output = Array.from({ length: 205 }, (_, i) => `L${i}`).join('\n')
    const body = formatToolBody('read_file', { path: 'a' }, output)
    expect(body).toHaveLength(201)
    expect(body[200]!.text).toBe('…（其余 5 行）')
  })
})
