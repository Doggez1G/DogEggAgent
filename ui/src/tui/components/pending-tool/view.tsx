import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'

// Braille spinner 帧序列——与 StatusBar 同款（80ms/帧，完整一圈 800ms）。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 模型正在生成工具调用参数（tool_pending → tool_start 之间的空窗）。
// 参数可能很大（整文件写入可达数万字符），这段窗口里流式文本是冻结的、
// 工具块尚未出现——用一条带动画的提示行明确「正在准备工具调用」。
// tool_start 到达后 reducer 清除 pendingTool，本组件随之消失、真实工具块接位。
export function PendingTool(props: { name: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <Box paddingLeft={1}>
      <Text color={palette.cyan}>{SPINNER_FRAMES[frame]} 🐾 {props.name || '工具'} · 正在生成调用参数…</Text>
    </Box>
  )
}
