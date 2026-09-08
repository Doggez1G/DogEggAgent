import type { Key } from 'ink'
import { isExpandable } from '../../../shared'
import type { Block } from '../../../shared'

export interface BrowseKeysApi {
  getBrowseIdx(): number | null
  setBrowseIdx(value: number | null): void
  getBlocks(): Block[]
  isExpanded(index: number): boolean
  toggleExpanded(index: number): void
  clearScreenRemount(): void
}

// 浏览模式按键：Ctrl+↑↓ 在块间移动焦点，Enter 切换折叠/展开（清屏重绘 Static），
// Esc 退出浏览。返回 true 表示已处理（调用方不再分派历史召回）。
export function handleBrowseKeys(key: Key, api: BrowseKeysApi): boolean {
  const blockCount = api.getBlocks().length
  if (key.ctrl && key.upArrow && blockCount > 0) {
    const cur = api.getBrowseIdx()
    api.setBrowseIdx(cur === null ? blockCount - 1 : Math.max(0, cur - 1))
    return true
  }
  if (key.ctrl && key.downArrow && blockCount > 0) {
    const cur = api.getBrowseIdx()
    api.setBrowseIdx(cur === null ? 0 : Math.min(blockCount - 1, cur + 1))
    return true
  }
  if (key.return && api.getBrowseIdx() !== null) {
    const idx = api.getBrowseIdx()!
    const block = api.getBlocks()[idx]
    // 仅思考/工具块可展开（判定归 shared/isExpandable，不在此重复实现）。
    if (block && isExpandable(block)) {
      api.toggleExpanded(idx)
      // 折叠状态变化 → 清屏重绘 Static（已打印内容无法就地修改）。
      api.clearScreenRemount()
    }
    return true
  }
  if (key.escape && api.getBrowseIdx() !== null) { api.setBrowseIdx(null); return true }
  return false
}
