import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 顶部品牌条：emoji 品牌 + 版本 + 当前 provider/model，用色条分隔增加层次。
export function TopBar(props: { info: string }) {
  return (
    <Box marginBottom={1} gap={1}>
      <Text bold color={palette.accent}>🐶🥚 DogEggAgent</Text>
      <Text color={palette.subtext}>v0.1.0</Text>
      <Text color={palette.subtext}>│</Text>
      <Text dimColor>{props.info}</Text>
    </Box>
  )
}
