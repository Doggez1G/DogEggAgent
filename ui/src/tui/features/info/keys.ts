import type { Key } from 'ink'
import type { View } from '../../view-state'

export interface InfoKeysApi {
  setView(view: View): void
  setInfoScroll(updater: (s: number) => number): void
}

// 信息面板按键：esc 关闭（带 returnView 时回到来源视图——面板内钻入的详情回到来源面板），
// ↑/↓ 翻页（固定 10 行步进）。
export function handleInfoKeys(v: Extract<View, { kind: 'info' }>, key: Key, api: InfoKeysApi): void {
  const page = 10
  if (key.escape) api.setView(v.returnView ?? { kind: 'none' })
  else if (key.upArrow) api.setInfoScroll((s) => Math.min(s + page, Math.max(0, v.lines.length - 1)))
  else if (key.downArrow) api.setInfoScroll((s) => Math.max(0, s - page))
}
