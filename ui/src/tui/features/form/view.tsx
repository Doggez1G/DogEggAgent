import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { View } from '../../view-state'

// 表单面板（/mcp、/skills 新建/编辑共用）：一行一字段 + 末尾保存行。
// 字段值显示：选项字段显示当前 value 对应的 label；文本字段空值显示（空）。
// 纯渲染——按键在 keys.ts。
export function FormPanel({ view }: { view: Extract<View, { kind: 'form' }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>{view.title}</Text>
      {view.fields.map((f, i) => {
        const active = i === view.cursor
        const shown = f.options ? (f.options.find((o) => o.value === f.value)?.label ?? f.value) : f.value || '（空）'
        return (
          <Text key={f.label} inverse={active} color={active ? undefined : palette.subtext} wrap="truncate">
            {active ? '> ' : '  '}{f.label}：{shown}{f.readonly ? '（锁定）' : ''}
          </Text>
        )
      })}
      <Text inverse={view.cursor === view.fields.length} wrap="truncate">
        {view.cursor === view.fields.length ? '> ' : '  '}✓ {view.submitLabel}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择 · Enter 编辑/切换 · s 保存 · esc 返回不保存</Text>
      </Box>
    </Box>
  )
}
