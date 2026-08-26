import { Lexer } from 'marked'

// marked token 的宽松形状：只取渲染纯文本需要的字段，避免与 marked 内部类型强耦合。
interface MdToken {
  type: string
  text?: string
  raw?: string
  tokens?: MdToken[]
  items?: { tokens?: MdToken[] }[]
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

// 把 markdown 渲染成「干净纯文本」：去掉 # / 反引号 / ** 等语法噪音，保留标题、代码块、列表、引用的可读结构。
// 有意不产出 ANSI（marked-terminal 的 ANSI 会与 Ink 的颜色处理冲突），着色统一交给 MessageBlock。
export function renderMarkdown(md: string): string {
  const tokens = new Lexer().lex(md) as unknown as MdToken[]
  const lines: string[] = []
  for (const t of tokens) {
    if (t.type === 'heading') lines.push((t.text ?? '').trim())
    else if (t.type === 'paragraph') lines.push(inlineText(t.tokens).trim())
    else if (t.type === 'code') lines.push((t.text ?? '').replace(/\n$/, ''))
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