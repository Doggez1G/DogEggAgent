import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// Codex 风格品牌横幅：圆角框 + 品牌行 + 键值对信息（label 对齐 + 值 + cyan 提示）。
// 作为 Static 首项打印一次（进终端缓冲区，不随动态区重绘）。
export function TopBar(props: { info: string; sessionId?: string; cwd?: string }) {
  const cwdStr = props.cwd ? props.cwd.replace(/\\/g, '/').split('/').pop() : undefined
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.subtext}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      alignSelf="flex-start"
      minWidth={52}
      gap={0}
    >
      <Text>
        <Text>🐶🥚 </Text>
        <Text bold>DogEggAgent</Text>
        <Text dimColor> (v0.1.0)</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={palette.subtext}>model:      </Text>
          <Text>{props.info}</Text>
          <Text color={palette.cyan}>  /model 切换</Text>
        </Box>
        <Box>
          <Text color={palette.subtext}>directory:  </Text>
          <Text>{cwdStr ?? '—'}</Text>
        </Box>
        <Box>
          <Text color={palette.subtext}>session:    </Text>
          <Text>{props.sessionId ? props.sessionId.slice(0, 8) : '—'}</Text>
        </Box>
      </Box>
    </Box>
  )
}
