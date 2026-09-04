import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// DogEgg 品牌 Banner：圆角框 + 品牌 + slogan + 会话信息。
// 作为 Static 首项打印一次（进终端缓冲区，不随动态区重绘）。
export function TopBar(props: { info: string; sessionId?: string; cwd?: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.accent}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      flexShrink={0}
      gap={0}
    >
      <Text>
        <Text>🐶🥚 </Text>
        <Text bold color={palette.accent}>DogEggAgent</Text>
        <Text dimColor> v0.1.0</Text>
        <Text dimColor> · 汪！代码交给狗蛋</Text>
      </Text>
      <Text dimColor>
        {props.info}
        {props.cwd ? ` · 📂 ${props.cwd}` : ''}
        {props.sessionId ? ` · 🔖 ${props.sessionId}` : ''}
      </Text>
      <Text dimColor>输入 /help 查看命令 · Ctrl+C 中断/退出 · 鼠标滚轮查看历史</Text>
    </Box>
  )
}
