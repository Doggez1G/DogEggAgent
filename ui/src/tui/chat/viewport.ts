import type { Block } from './block'

// 粗略估算一个消息块占用的终端行数（角色头 1 + 正文换行 + 上下边框 2），用于消息视口的自动滚动裁切。
export function estimateBlockLines(text: string, width: number): number {
  const lineWidth = Math.max(10, width - 6)
  const body = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / lineWidth)), 0)
  return body + 3
}

// 渲染后的块（markdown 已渲染 + 展开/折叠状态已决定 + 行数已估算）。
export interface DisplayBlock extends Block {
  index: number
  lines: number
  shownText: string
  isCollapsed: boolean
}

// 按展开状态决定每块「实际显示文本」：
// 可折叠块（思考/工具）折叠时显示摘要，展开时显示 full。
// 行数据此估算，保证展开后滚动裁剪仍准确。
export function buildDisplayBlocks(
  blocks: Block[],
  expanded: ReadonlySet<number>,
  termWidth: number,
  isMarkdown: (icon: string) => boolean,
): DisplayBlock[] {
  return blocks.map((b, i) => {
    const text = isMarkdown(b.icon) ? b.text : b.text // markdown 渲染由调用方在传入前完成
    // 只有有 full 内容的块才可折叠（tool_end 后的完整结果、thinking 的完整推理）。
    // tool_start 后但 tool_end 前的块无 full，不可折叠。
    const expandable = (b.icon === '🐣' || b.icon === '🐾') && b.full !== undefined
    const isExpanded = expanded.has(i)
    const shownText = !expandable
      ? text
      : isExpanded
        ? (b.icon === '🐾' ? (b.full ?? b.text) : b.text)
        : (b.icon === '🐣' ? '（思考已折叠）' : b.text)
    return { ...b, index: i, lines: estimateBlockLines(shownText, termWidth), shownText, isCollapsed: expandable && !isExpanded }
  })
}

// 滚动窗口裁切：从所有块中选出可见窗口内的块。
export function sliceViewport(displayBlocks: DisplayBlock[], viewportHeight: number, scroll: number): DisplayBlock[] {
  const totalLines = displayBlocks.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  const visibleTop = totalLines - viewportHeight - scrolled
  let acc = 0
  const visibleBlocks: DisplayBlock[] = []
  for (const b of displayBlocks) {
    const start = acc
    acc += b.lines
    if (acc <= visibleTop) continue
    if (start >= visibleTop + viewportHeight) break
    visibleBlocks.push(b)
  }
  return visibleBlocks
}
