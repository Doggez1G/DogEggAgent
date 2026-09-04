import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// DogEgg 品牌 Banner：框内品牌+slogan，框外 dim 会话信息与快捷键提示。
// 作为 Static 首项打印一次（进终端缓冲区，不随动态区重绘）。
export function TopBar(props: { info: string; sessionId?: string; cwd?: string }) {
  const cwdStr = props.cwd ? props.cwd.replace(/\\/g, '/').split('/').pop() : undefined
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        paddingX={2}
        alignSelf="flex-start"
      >
        <Text>
          <Text>🐶🥚 </Text>
          <Text bold color={palette.accent}>DogEggAgent</Text>
          <Text dimColor> v0.1.0</Text>
        </Text>
        <Text dimColor>汪！代码交给狗蛋</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          {props.info}
          {cwdStr ? `  ·  📂 ${cwdStr}` : ''}
          {props.sessionId ? `  ·  🔖 ${props.sessionId.slice(0, 8)}` : ''}
        </Text>
        <Text dimColor>/help 命令  ·  Ctrl+C 中断/退出  ·  滚轮翻历史  ·  Ctrl+↑↓ 浏览消息</Text>
      </Box>
    </Box>
  )
}
