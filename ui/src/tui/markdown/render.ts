import { Lexer } from 'marked'
import { highlight } from 'cli-highlight'
import chalk from 'chalk'

// marked token 的宽松形状：只取渲染纯文本需要的字段，避免与 marked 内部类型强耦合。
interface MdToken {
  type: string
  text?: string
  raw?: string
  lang?: string
  tokens?: MdToken[]
  items?: { tokens?: MdToken[] }[]
}

// cli-highlight 的 theme 函数接收原始字符串、返回带 ANSI 的字符串。
// chalk.level = 1 强制基础 ANSI（256-color 在某些终端会冲突，基础色最安全）。
chalk.level = 1

const CODE_THEME = {
  keyword: (s: string) => chalk.blue(s),
  string: (s: string) => chalk.green(s),
  function: (s: string) => chalk.yellow(s),
  number: (s: string) => chalk.cyan(s),
  comment: (s: string) => chalk.gray(s),
  title: (s: string) => chalk.yellow(s),
  built_in: (s: string) => chalk.magenta(s),
  type: (s: string) => chalk.cyan(s),
  literal: (s: string) => chalk.cyan(s),
  regexp: (s: string) => chalk.red(s),
}

function inlineText(tokens: MdToken[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((t) => {
      if (t.type === 'codespan' || t.type === 'text' || t.type === 'escape') return t.text ?? ''
      if (t.type === 'strong' || t.type === 'em' || t.type === 'del') return inlineText(t.tokens)
      if (t.type === 'link') return t.text ?? ''
      if (t.type === 'br') return '\n'
      return t.raw ?? ''
    })
    .join('')
}

// 把 markdown 渲染成「干净纯文本 + 代码块 ANSI 高亮」。
// 非 code 部分去掉 # / 反引号 / ** 等语法噪音，保留标题、列表、引用的可读结构。
// code 部分用 cli-highlight 加 ANSI 色（keyword/string/function/number/comment 等）。
export function renderMarkdown(md: string): string {
  const tokens = new Lexer().lex(md) as unknown as MdToken[]
  const lines: string[] = []
  for (const t of tokens) {
    if (t.type === 'heading') lines.push((t.text ?? '').trim())
    else if (t.type === 'paragraph') lines.push(inlineText(t.tokens).trim())
    else if (t.type === 'code') {
      const code = (t.text ?? '').replace(/\n$/, '')
      const lang = t.lang ?? undefined
      // 有语言标签且 cli-highlight 支持时高亮，否则原样输出。
      if (lang) {
        try {
          lines.push(highlight(code, { language: lang, theme: CODE_THEME }))
        } catch {
          lines.push(code)
        }
      } else {
        lines.push(code)
      }
    }
    else if (t.type === 'list') {
      for (const item of t.items ?? []) lines.push('• ' + inlineText(item.tokens).trim())
    } else if (t.type === 'blockquote') {
      for (const l of inlineText(t.tokens).split('\n')) lines.push('│ ' + l)
    } else if (t.type === 'hr') lines.push('────────')
    else if (t.type === 'space') continue
    else if (t.raw) lines.push(t.raw.trim())
  }
  return lines.join('\n')
}
