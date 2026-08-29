import { isExpandable } from '../../shared/block'
import type { Block } from '../../shared/block'

// 块浏览：在可折叠块（思考/工具）间移动焦点、展开/折叠。
// 焦点用 index 表示；expanded 是一个 Set<number>。

// 找出所有可折叠块的 index 列表。
// 只有有 full 内容的块才可折叠——tool_start 后但 tool_end 前的块无 full，不可折叠。
export function expandableIndices(blocks: Block[]): number[] {
  return blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => isExpandable(b))
    .map(({ i }) => i)
}

// 按方向移动浏览焦点。未聚焦时按 ↑ 从最后一个开始，↓ 从第一个开始；已聚焦则按方向在原地上下移动并回绕。
export function moveBrowse(blocks: Block[], current: number | null, up: boolean): number | null {
  const expandable = expandableIndices(blocks)
  if (expandable.length === 0) return null
  const idx = current === null ? -1 : expandable.indexOf(current)
  return up
    ? expandable[(idx < 0 ? expandable.length - 1 : (idx - 1 + expandable.length) % expandable.length)]!
    : expandable[(idx < 0 ? 0 : (idx + 1) % expandable.length)]!
}

// 切换某个块的展开/折叠状态，返回新 Set。
export function toggleExpanded(expanded: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(expanded)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  return next
}
