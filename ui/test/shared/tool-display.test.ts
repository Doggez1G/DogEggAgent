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
  it('shell：成功量化真实行数（exit 行与幻影尾空行不计）', () => {
    expect(formatToolResult('shell', 'exit=0\na\nb\n')).toBe('2 行输出')
  })
  it('shell：exit≠0 提升为 ✕ 退出 N（驱动红色结果标签）', () => {
    expect(formatToolResult('shell', 'exit=1\nFAIL\n')).toBe('✕ 退出 1')
  })
  it('read_file 量化行数（幻影尾空行不计）', () => {
    expect(formatToolResult('read_file', 'a\nb\n')).toBe('2 行')
  })
  it('其它工具完成', () => {
    expect(formatToolResult('edit_file', '已替换 1 处')).toBe('完成')
  })
  it('denied → 已拒绝；其它错误 → ✕ 原因', () => {
    expect(formatToolResult('shell', 'denied', 'denied')).toBe('已拒绝')
    expect(formatToolResult('shell', '', '参数校验失败')).toBe('✕ 参数校验失败')
  })
})

describe('formatToolTitle', () => {
  it('name + 参数段 + 结果段', () => {
    expect(formatToolTitle('shell', { command: 'ls' }, 'exit=0\na\nb\n')).toBe('shell $ ls · 2 行输出')
  })
  it('running 无结果段', () => {
    expect(formatToolTitle('read_file', { path: 'a.ts' })).toBe('read_file a.ts')
  })
  it('参数为空时不产生多余空格', () => {
    expect(formatToolTitle('custom', {})).toBe('custom')
  })
})

describe('formatToolBody', () => {
  it('shell：命令回显为 cmd 行，exit=0 行丢弃，幻影尾空行去除', () => {
    expect(formatToolBody('shell', { command: 'echo hi' }, 'exit=0\nhi\n')).toEqual([
      { text: '$ echo hi', kind: 'cmd' },
      { text: 'hi', kind: 'plain' },
    ])
  })
  it('shell：exit≠0 退出码不进正文（提升到头行），超时说明保留为正文行', () => {
    expect(formatToolBody('shell', { command: 'npm test' }, 'exit=124（命令超过 120s 未结束）\npartial\n')).toEqual([
      { text: '$ npm test', kind: 'cmd' },
      { text: '（命令超过 120s 未结束）', kind: 'plain' },
      { text: 'partial', kind: 'plain' },
    ])
  })
  it('read_file：内容带 1-based 行号（no 字段，渲染层画侧栏、复制不含）', () => {
    expect(formatToolBody('read_file', { path: 'a' }, 'a\nb\n')).toEqual([
      { text: 'a', no: 1, kind: 'plain' },
      { text: 'b', no: 2, kind: 'plain' },
    ])
  })
  it('write_file：内容带行号的编辑器式呈现（不再整篇标绿）', () => {
    expect(formatToolBody('write_file', { content: 'a\nb' })).toEqual([
      { text: 'a', no: 1, kind: 'plain' },
      { text: 'b', no: 2, kind: 'plain' },
    ])
  })
  it('read_file 空文件', () => {
    expect(formatToolBody('read_file', { path: 'a' }, '')).toEqual([{ text: '（空文件）', kind: 'plain' }])
  })
  it('edit_file：回执含锚点时 diff 标真实行号（删=旧位置，存=新位置）', () => {
    expect(formatToolBody('edit_file',
      { path: 'a.ts', old_string: 'ctx\nold\ntail', new_string: 'ctx\nnew1\nnew2\ntail' },
      '已替换 1 处（原第 41 行起）',
    )).toEqual([
      { text: '  ctx', no: 41, kind: 'plain' },
      { text: '- old', no: 42, kind: 'del' },
      { text: '+ new1', no: 42, kind: 'add' },
      { text: '+ new2', no: 43, kind: 'add' },
      { text: '  tail', no: 44, kind: 'plain' },
    ])
  })
  it('edit_file：回执无锚点（旧格式/旧会话回放）不标行号', () => {
    expect(formatToolBody('edit_file', { old_string: 'old', new_string: 'new' }, '已替换 1 处')).toEqual([
      { text: '- old', kind: 'del' },
      { text: '+ new', kind: 'add' },
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
  it('错误：✕ 行在前，部分输出随后（如 shell 超时前已产生的输出）', () => {
    const body = formatToolBody('shell', { command: 'ls' }, 'partial', '命令超过 120s 未结束')
    expect(body[0]).toEqual({ text: '✕ 命令超过 120s 未结束', kind: 'plain' })
    expect(body[1]).toEqual({ text: 'partial', kind: 'plain' })
  })
  it('超长输出封顶 200 行并标注剩余', () => {
    const output = Array.from({ length: 205 }, (_, i) => `L${i}`).join('\n')
    const body = formatToolBody('read_file', { path: 'a' }, output)
    expect(body).toHaveLength(201)
    expect(body[200]!.text).toBe('…（其余 5 行）')
  })
})

describe('探索类工具（ls/glob/grep）formatter', () => {
  it('args：ls 路径 / glob 模式+起点 / grep 模式+glob 过滤', () => {
    expect(formatToolArgs('ls', { path: 'src' })).toBe('src')
    expect(formatToolArgs('glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(formatToolArgs('glob', { pattern: '**/*.ts', path: 'src' })).toBe('**/*.ts in src')
    expect(formatToolArgs('grep', { pattern: 'needle', glob: '*.ts' })).toBe('needle in *.ts')
  })

  it('result：ls 项数 / glob 文件数 / grep content 模式处命中', () => {
    expect(formatToolResult('ls', 'src/\npackage.json  1.2 KB')).toBe('2 项')
    expect(formatToolResult('glob', 'a.ts\nsrc/b.ts')).toBe('2 个文件')
    expect(formatToolResult('grep', 'a.ts:1: needle\nsrc/b.ts:2: needle')).toBe('2 处命中')
  })

  it('result：grep 文件级模式（files_with_matches/count）按形状识别为文件数', () => {
    expect(formatToolResult('grep', 'a.ts\nb.ts')).toBe('2 个文件')
    expect(formatToolResult('grep', 'a.ts: 2\nb.ts: 1')).toBe('2 个文件')
  })

  it('result：截断说明行不计数（ls 封顶说明 / grep 单文件补数说明）', () => {
    const lsOutput = `${Array.from({ length: 500 }, (_, i) => `f${i}`).join('\n')}\n（仅显示前 500 项，共 505 项）`
    expect(formatToolResult('ls', lsOutput)).toBe('500 项')
    const grepOutput = 'a.ts:1: hit\na.ts（该文件还有 3 处未显示）'
    expect(formatToolResult('grep', grepOutput)).toBe('1 处命中')
  })

  it('body：走默认 plainLines（命中行保留 path:line: 前缀原文）', () => {
    expect(formatToolBody('grep', { pattern: 'x' }, 'a.ts:1: hit')).toEqual([
      { text: 'a.ts:1: hit', kind: 'plain' },
    ])
  })

  it('title：折叠头行拼装（args · result）', () => {
    expect(formatToolTitle('grep', { pattern: 'needle' }, 'a.ts:1: needle')).toBe('grep needle · 1 处命中')
  })
})
