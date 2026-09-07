import React from 'react'
import { ListPicker } from '../../components'
import type { View } from '../../view-state'

// 菜单弹层视图：标题 + 选项列表（ListPicker 封装）。
export function MenuOverlay({ view }: { view: Extract<View, { kind: 'menu' }> }) {
  return <ListPicker title={view.title} items={view.items.map((i) => i.label)} cursor={view.cursor} hint="↑↓ 选择 · 回车确认 · esc 返回" />
}
