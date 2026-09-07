import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { View } from '../../view-state'

// 信息面板视图：标题 + 尾部窗口化内容（scroll 为从底部往上的翻页行数）。
export function InfoOverlay({ view, scroll }: { view: Extract<View, { kind: 'info' }>; scroll: number }) {
  const WIN = 15
  const start = Math.max(0, view.lines.length - scroll - WIN)
  const windowed = view.lines.slice(start, start + WIN)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>{view.title}</Text>
      {windowed.map((line, i) => (
        <Text key={i} dimColor={line.startsWith('─') || line.startsWith('路径')}>{line}</Text>
      ))}
      <Text dimColor>↑↓ 翻页 · esc 关闭</Text>
    </Box>
  )
}
