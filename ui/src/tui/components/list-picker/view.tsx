import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 通用选项列表：权限三选 / 会话选择器 / 模型选择器 / 配置树的覆盖层共用。
// 圆角框 + dim 边框 + accent 标题 + cursor 反色高亮。
// 窗口化：最多显示 12 项（动态区不能超长——否则 Ink 重绘混乱），cursor 靠边时窗口滚动。
export function ListPicker(props: { title: string; items: string[]; cursor: number; hint: string }) {
  const WIN = 12
  const total = props.items.length
  const start = Math.max(0, Math.min(props.cursor - WIN + 3, Math.max(0, total - WIN)))
  const windowed = props.items.slice(start, start + WIN)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1}>
      <Text bold color={palette.accent}>{props.title}</Text>
      {total === 0 ? (
        <Text dimColor>（暂无，esc 返回）</Text>
      ) : (
        windowed.map((it, i) => {
          const realIdx = start + i
          return (
            <Text key={realIdx} inverse={realIdx === props.cursor}>{realIdx === props.cursor ? '> ' : '  '}{it}</Text>
          )
        })
      )}
      {total > WIN && <Text dimColor>（{total} 项，↑↓ 滚动）</Text>}
      <Text dimColor>{props.hint}</Text>
    </Box>
  )
}
