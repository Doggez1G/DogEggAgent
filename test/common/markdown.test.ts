import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../src/common/utils/markdown'

describe('renderMarkdown', () => {
  it('strips heading markers', () => {
    expect(renderMarkdown('# 标题')).toBe('标题')
  })

  it('strips inline bold and code markers', () => {
    expect(renderMarkdown('这是 **加粗** 和 `code`')).toBe('这是 加粗 和 code')
  })

  it('normalizes list bullets', () => {
    expect(renderMarkdown('- a\n- b')).toBe('• a\n• b')
  })

  it('keeps code block content without fences', () => {
    expect(renderMarkdown('```\nconst x = 1\n```')).toBe('const x = 1')
  })

  it('leaves plain text unchanged', () => {
    expect(renderMarkdown('hello world')).toBe('hello world')
  })
})