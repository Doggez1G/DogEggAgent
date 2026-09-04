import type { Block } from '../../shared'
import { isExpandable } from '../../shared'

// 去除 ANSI 转义序列——cli-highlight 等库注入的颜色码不计入终端显示宽度。
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// 估算一个消息块占用的终端行数：角色头(1) + 正文行 + marginBottom(1) = body + 2。
// MessageBlock 渲染结构：1行角色头 + 缩进正文 + 1行底部留白。
export function estimateBlockLines(text: string, width: number): number {
  const clean = stripAnsi(text)
  const lineWidth = Math.max(10, width - 6)
  const body = clean.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / lineWidth)), 0)
  return body + 2
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
// markdown 渲染由调用方在传入前完成，此函数只管展开/折叠的文本选择。
export function buildDisplayBlocks(
  blocks: Block[],
  expanded: ReadonlySet<number>,
  termWidth: number,
): DisplayBlock[] {
  return blocks.map((b, i) => {
    // isExpandable 检查 kind + full——语义判断，不依赖具体图标值。
    const expandable = isExpandable(b)
    const isExpanded = expanded.has(i)
    const shownText = !expandable
      ? b.text
      : isExpanded
        ? (b.full ?? b.text) // 展开：tool 和 thinking 都显示 full
        : b.text // 折叠：显示 text（摘要）
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
