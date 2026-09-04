import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../../src/tui/markdown'

// 去除 ANSI 转义便于断言纯文本结构。
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('renderMarkdown', () => {
  it('strips heading markers (styled bold)', () => {
    const out = renderMarkdown('# 标题')
    expect(plain(out)).toBe('标题')
    expect(out).toContain('\x1b[1m') // 标题保留终端粗体样式
  })

  it('renders inline bold and code as ANSI styles', () => {
    const out = renderMarkdown('这是 **加粗** 和 `code`')
    expect(plain(out)).toBe('这是 加粗 和 code')
    expect(out).toContain('\x1b[1m加粗') // strong → bold
    expect(out).toContain('\x1b[36mcode') // codespan → cyan
  })

  it('normalizes list bullets', () => {
    expect(plain(renderMarkdown('- a\n- b'))).toBe('• a\n• b')
  })

  it('keeps code block content without fences', () => {
    expect(plain(renderMarkdown('```\nconst x = 1\n```'))).toBe('const x = 1')
  })

  it('leaves plain text unchanged', () => {
    expect(renderMarkdown('hello world')).toBe('hello world')
  })
})
