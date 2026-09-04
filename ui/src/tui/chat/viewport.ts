import type { Block } from '../../shared'
import { isExpandable } from '../../shared'

// 去除 ANSI 转义序列——cli-highlight 等库注入的颜色码不计入终端显示宽度。
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// 估算一个消息块占用的终端行数：角色头(1) + 正文行 + marginBottom(1) = body + 2。
// MessageBlock 渲染结构：左侧色条(1字符) + gap(1) + 正文 → 正文宽度 = termWidth - 2。
export function estimateBlockLines(text: string, width: number): number {
  const clean = stripAnsi(text)
  const lineWidth = Math.max(10, width - 2) // 色条(1) + gap(1)
  const body = clean.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / lineWidth)), 0)
  return body + 2
}

// 将文本按终端宽度拆成显示行列表（每个元素是一行）。
function splitToLines(text: string, width: number): string[] {
  const clean = stripAnsi(text)
  const lineWidth = Math.max(10, width - 2) // 色条(1) + gap(1)
  const lines: string[] = []
  for (const para of clean.split('\n')) {
    if (para.length === 0) { lines.push(''); continue }
    for (let i = 0; i < para.length; i += lineWidth) {
      lines.push(para.slice(i, i + lineWidth))
    }
  }
  return lines
}

// 渲染后的块（markdown 已渲染 + 展开/折叠状态已决定 + 行数已估算）。
export interface DisplayBlock extends Block {
  index: number
  lines: number
  shownText: string
  isCollapsed: boolean
}

// 按展开状态决定每块「实际显示文本」。
export function buildDisplayBlocks(
  blocks: Block[],
  expanded: ReadonlySet<number>,
  termWidth: number,
): DisplayBlock[] {
  return blocks.map((b, i) => {
    const expandable = isExpandable(b)
    const isExpanded = expanded.has(i)
    const shownText = !expandable
      ? b.text
      : isExpanded
        ? (b.full ?? b.text)
        : b.text
    return { ...b, index: i, lines: estimateBlockLines(shownText, termWidth), shownText, isCollapsed: expandable && !isExpanded }
  })
}

// 视口裁切：保留可见窗口内的块，对部分可见的块截取其文本行。
// scroll=0 表示在底部（显示最新内容），scroll>0 表示向上滚动了 scroll 行。
export interface SlicedBlock extends DisplayBlock {
  slicedText: string // 实际应渲染的文本（可能被截取）
  showHeader: boolean // 是否显示角色头（块顶部被裁切时不显示）
}

export function sliceViewport(displayBlocks: DisplayBlock[], viewportHeight: number, scroll: number, termWidth: number): SlicedBlock[] {
  const totalLines = displayBlocks.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  // visibleTop = 从顶部隐藏的行数。scroll=0 时 visibleTop = totalLines - viewportHeight（显示底部）。
  const visibleTop = totalLines - viewportHeight - scrolled
  const visibleBottom = visibleTop + viewportHeight

  const result: SlicedBlock[] = []
  let acc = 0
  for (const b of displayBlocks) {
    const blockTop = acc
    const blockBottom = acc + b.lines
    acc = blockBottom

    // 块完全在可见窗口上方——跳过。
    if (blockBottom <= visibleTop) continue
    // 块完全在可见窗口下方——跳过。
    if (blockTop >= visibleBottom) break

    // 块与可见窗口有交集——可能需要截取。
    const linesHiddenAbove = Math.max(0, visibleTop - blockTop) // 块顶部被裁掉的行数
    const linesHiddenBelow = Math.max(0, blockBottom - visibleBottom) // 块底部被裁掉的行数

    // 块结构：1行角色头 + 正文行 + 1行marginBottom
    // linesHiddenAbove=0 → 显示完整块（含角色头）
    // linesHiddenAbove>=1 → 角色头被裁掉，只显示正文的一部分
    const showHeader = linesHiddenAbove === 0
    const headerOffset = 1 // 角色头占1行
    const marginOffset = 1 // marginBottom占1行

    if (linesHiddenAbove === 0 && linesHiddenBelow === 0) {
      // 完全可见——不需要截取
      result.push({ ...b, slicedText: b.shownText, showHeader: true })
      continue
    }

    // 需要截取正文文本
    const bodyLines = splitToLines(b.shownText, termWidth)
    // 正文在块中的起始行（跳过角色头）
    const bodyStartInBlock = headerOffset
    // 要从正文中跳过的行数 = max(0, linesHiddenAbove - headerOffset)
    const bodySkip = Math.max(0, linesHiddenAbove - headerOffset)
    // 要保留的正文行数 = 块总行数 - 头 - margin - 跳过 - 底部裁切
    const bodyKeep = b.lines - headerOffset - marginOffset - bodySkip - linesHiddenBelow
    const bodySlice = bodyLines.slice(bodySkip, bodySkip + Math.max(0, bodyKeep))

    result.push({ ...b, slicedText: bodySlice.join('\n'), showHeader })
  }
  return result
}
