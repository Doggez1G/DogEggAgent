import React from 'react'
import { ListPicker } from '../../components'
import { entryLabel } from './label'
import type { Entry } from './entries'
import type { View } from '../../view-state'

// 配置编辑器视图：标题 + entry 标签列表（bool 项预览态由 entryLabel 呈现）。
export function ConfigOverlay({ view, entries }: { view: Extract<View, { kind: 'config' }>; entries: Entry[] }) {
  return (
    <ListPicker
      title={`配置 / ${view.path.kind}`}
      items={entries.map((e, i) => entryLabel(e, i === view.cursor && e.kind === 'bool' ? (view.preview ?? e.value) : undefined))}
      cursor={view.cursor}
      hint="↑↓ 选择 · 回车钻入/编辑 · ←→ 切布尔 · d 删 · esc 返回"
    />
  )
}
