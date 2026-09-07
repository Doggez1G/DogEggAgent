import type { Key } from 'ink'
import type { View } from '../../view-state'

export interface MenuKeysApi {
  setView(view: View): void
}

// 菜单弹层按键：↑↓ 循环选择（空菜单防除零），回车执行选中项的 onSelect，esc 关闭。
export function handleMenuKeys(v: Extract<View, { kind: 'menu' }>, key: Key, api: MenuKeysApi): void {
  const len = Math.max(1, v.items.length)
  if (key.upArrow) api.setView({ ...v, cursor: (v.cursor - 1 + len) % len })
  else if (key.downArrow) api.setView({ ...v, cursor: (v.cursor + 1) % len })
  else if (key.return) v.items[v.cursor]?.onSelect()
  else if (key.escape) api.setView({ kind: 'none' })
}
