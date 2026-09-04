import { Lexer } from 'marked'
import { highlight } from 'cli-highlight'
import chalk from 'chalk'
import { palette } from '../theme'

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

// hex → truecolor ANSI 前景码（heading/bullet 用主题 accent 色着色）。
function accentAnsi(): string {
  const hex = palette.accent
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

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

// 行内富文本 ANSI：bold/italic/codespan 保留终端样式（Ink Text 会透传 ANSI 序列）。
const BOLD = '\x1b[1m'
const ITALIC = '\x1b[3m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[22m\x1b[23m\x1b[39m'

function inlineRich(tokens: MdToken[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((t) => {
      if (t.type === 'codespan') return CYAN + (t.text ?? '') + RESET
      if (t.type === 'text' || t.type === 'escape') return t.text ?? ''
      if (t.type === 'strong') return BOLD + inlineRich(t.tokens) + RESET
      if (t.type === 'em' || t.type === 'del') return ITALIC + inlineRich(t.tokens) + RESET
      if (t.type === 'link') return t.text ?? ''
      if (t.type === 'br') return '\n'
      return t.raw ?? ''
    })
    .join('')
}

// 把 markdown 渲染成「终端富文本 + 代码块 ANSI 高亮」。
// 标题/列表/引用保留结构；heading/bullet 用主题 accent 色；strong/em/codespan 用 ANSI 样式。
export function renderMarkdown(md: string): string {
  const tokens = new Lexer().lex(md) as unknown as MdToken[]
  const accent = accentAnsi()
  const lines: string[] = []
  for (const t of tokens) {
    if (t.type === 'heading') lines.push(BOLD + accent + (t.text ?? '').trim() + RESET)
    else if (t.type === 'paragraph') lines.push(inlineRich(t.tokens).trim())
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
      for (const item of t.items ?? []) lines.push(accent + '•' + RESET + ' ' + inlineRich(item.tokens).trim())
    } else if (t.type === 'blockquote') {
      for (const l of inlineRich(t.tokens).split('\n')) lines.push('│ ' + l)
    } else if (t.type === 'hr') lines.push('────────')
    else if (t.type === 'space') continue
    else if (t.raw) lines.push(t.raw.trim())
  }
  return lines.join('\n')
}
