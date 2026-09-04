import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// DogEgg 品牌横幅：accent 圆角框 + 蛋黄 slogan + 键值对信息。
// 作为 Static 首项打印一次（进终端缓冲区，不随动态区重绘）。
export function TopBar(props: { info: string; sessionId?: string; cwd?: string }) {
  const cwdStr = props.cwd ? props.cwd.replace(/\\/g, '/').split('/').pop() : undefined
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.border}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      alignSelf="flex-start"
      minWidth={52}
      gap={0}
    >
      <Text>
        <Text>🐶🥚 </Text>
        <Text bold color={palette.accent}>DogEggAgent</Text>
        <Text color={palette.faint}> (v0.1.0)</Text>
      </Text>
      <Text color={palette.yellow}>汪！代码交给狗蛋，剩下的交给我 🐾</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={palette.faint}>model:      </Text>
          <Text>{props.info}</Text>
          <Text color={palette.cyan}>  /model 切换</Text>
        </Box>
        <Box>
          <Text color={palette.faint}>directory:  </Text>
          <Text>{cwdStr ?? '—'}</Text>
        </Box>
        <Box>
          <Text color={palette.faint}>session:    </Text>
          <Text>{props.sessionId ? props.sessionId.slice(0, 8) : '—'}</Text>
        </Box>
      </Box>
    </Box>
  )
}
