import { isExpandable } from '../../shared'
import type { Block } from '../../shared'

// 块浏览：在所有消息块间移动焦点，可折叠块（思考/工具）可展开/折叠。
// 焦点用 index 表示；expanded 是一个 Set<number>。

// 找出所有可折叠块的 index 列表。
// 只有有 full 内容的块才可折叠——tool_start 后但 tool_end 前的块无 full，不可折叠。
export function expandableIndices(blocks: Block[]): number[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => isExpandable(b))
    .map(({ i }) => i)
}

// 在所有块间按方向移动焦点（不只限于可折叠块）。
// 未聚焦时按 ↑ 从最后一个开始，↓ 从第一个开始；已聚焦则按方向上下移动并回绕。
export function moveBrowse(blocks: Block[], current: number | null, up: boolean): number | null {
  if (blocks.length === 0) return null
  if (current === null) return up ? blocks.length - 1 : 0
  return up
    ? (current - 1 + blocks.length) % blocks.length
    : (current + 1) % blocks.length
}

// 切换某个块的展开/折叠状态，返回新 Set。
export function toggleExpanded(expanded: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(expanded)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  return next
}
