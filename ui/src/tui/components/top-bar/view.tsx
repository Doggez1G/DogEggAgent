import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// DogEgg 品牌 Banner：圆角框 + 品牌 + 版本 + 当前 provider/model。
// 作为 Static 首项打印一次（进终端缓冲区，不随动态区重绘）。
export function TopBar(props: { info: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.accent}
      paddingX={2}
      marginBottom={1}
      flexShrink={0}
    >
      <Text>
        <Text>🐶🥚 </Text>
        <Text bold color={palette.accent}>DogEggAgent</Text>
        <Text dimColor> v0.1.0</Text>
      </Text>
      <Text dimColor>{props.info} · 输入 /help 查看命令</Text>
    </Box>
  )
}
