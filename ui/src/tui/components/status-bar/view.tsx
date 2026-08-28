import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { State } from '@dogegg/bridge'
import { spinnerFrame, isAnimated } from '../../spinner'

// 状态栏：底色块 + 彩色状态点 + bold 文本 + provider/model/session/tokens 概览。
// 落地 spec §13/§14：`● state · provider/model · #sessionId · tokens/window`。
// 运行态显示狗蛋风格 spinner 动效（useEffect + setInterval 80ms/帧）。
export function StatusBar(props: {
  state: State
  provider?: string
  model?: string
  sessionId?: string
  tokens?: number
  windowTokens?: number
}) {
  const [frame, setFrame] = useState(0)

  // 只在运行态启动定时器——idle/finished 等不触发重渲染（性能考量）。
  const animated = isAnimated(props.state)
  useEffect(() => {
    if (!animated) return
    const timer = setInterval(() => setFrame((f) => f + 1), 80)
    return () => clearInterval(timer)
  }, [animated])

  // 状态 → 颜色映射（低饱和语义色）
  const stateColor: Record<string, string> = {
    idle: palette.subtext, thinking: palette.yellow, responding: palette.accent,
    tool_calling: palette.cyan, executing: palette.cyan, waiting_permission: palette.yellow,
    finished: palette.green, cancelled: palette.subtext, error: palette.red,
    compacting: palette.cyan,
  }
  const color = stateColor[props.state] ?? palette.subtext
  const spinner = spinnerFrame(props.state, frame)
  const tokensStr = props.tokens !== undefined && props.windowTokens !== undefined
    ? `${props.tokens}/${props.windowTokens}`
    : ''
  return (
    <Box gap={1}>
      <Text backgroundColor={palette.subtext} color={color}> {spinner} </Text>
      <Text bold color={color}>{props.state}</Text>
      {props.provider && props.model && <Text dimColor>· {props.provider}/{props.model}</Text>}
      {props.sessionId && <Text dimColor>· #{props.sessionId}</Text>}
      {tokensStr && <Text dimColor>· {tokensStr}</Text>}
    </Box>
  )
}
