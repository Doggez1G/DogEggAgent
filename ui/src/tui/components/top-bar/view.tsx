import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// 顶部品牌条：应用名 + 版本 + 当前 provider/model。
export function TopBar(props: { info: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold color={palette.accent}>🐶🥚 DogEggAgent v0.1.0</Text>
      <Text dimColor>  {props.info}</Text>
    </Box>
  )
}
