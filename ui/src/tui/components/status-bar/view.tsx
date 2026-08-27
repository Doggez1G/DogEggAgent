import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 状态栏：底色块 + 彩色状态点 + bold 文本，比 inverse 更有质感。
export function StatusBar(props: { state: string }) {
  // 状态 → 颜色映射（低饱和语义色）
  const stateColor: Record<string, string> = {
    idle: palette.subtext, thinking: palette.yellow, responding: palette.accent,
    tool_calling: palette.cyan, executing: palette.cyan, waiting_permission: palette.yellow,
    finished: palette.green, cancelled: palette.subtext, error: palette.red,
  }
  const color = stateColor[props.state] ?? palette.subtext
  return (
    <Box>
      <Text backgroundColor={palette.subtext} color={color}> ● </Text>
      <Text bold color={color}> {props.state} </Text>
    </Box>
  )
}
