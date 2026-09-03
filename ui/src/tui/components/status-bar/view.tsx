import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { State } from '@dogegg/bridge'

// Braille spinner 帧序列——10 帧循环，80ms/帧（12.5fps），完整一圈 800ms。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 运行态——需要 spinner 旋转动画。
const SPINNING_STATES: ReadonlySet<State> = new Set([
  'thinking', 'responding', 'tool_calling', 'executing', 'compacting',
])

// 状态 → (颜色, Emoji, 中文描述) 映射——落地设计 §14。
const STATE_META: Record<string, { color: string; emoji: string; label: string }> = {
  idle: { color: palette.subtext, emoji: '🥚', label: '空闲' },
  thinking: { color: palette.yellow, emoji: '🐣', label: '思考中' },
  responding: { color: palette.accent, emoji: '🐶', label: '回答中' },
  tool_calling: { color: palette.cyan, emoji: '🐾', label: '工具调用' },
  executing: { color: palette.cyan, emoji: '🐾', label: '执行中' },
  waiting_permission: { color: palette.yellow, emoji: '⚠', label: '等待审批' },
  finished: { color: palette.green, emoji: '🐥', label: '完成' },
  cancelled: { color: palette.subtext, emoji: '🥚', label: '已打断' },
  error: { color: palette.red, emoji: '🐶', label: '出错' },
  compacting: { color: palette.cyan, emoji: '🥚', label: '压缩中' },
}

// 状态栏：品牌前缀 + Emoji + Braille spinner + 状态文字 + provider/model/session/tokens/cwd。
// 运行态显示 spinner 旋转动画（useState + setInterval 定时切换帧），非运行态静态显示。
export function StatusBar(props: {
  state: string
  provider?: string
  model?: string
  sessionId?: string
  tokens?: number
  windowTokens?: number
  cwd?: string
}) {
  const meta = STATE_META[props.state] ?? { color: palette.subtext, emoji: '🥚', label: props.state }
  const isSpinning = SPINNING_STATES.has(props.state as State)
  const [frame, setFrame] = useState(0)

  // 运行态启动定时器切换 spinner 帧，非运行态停止——避免不必要重渲染。
  useEffect(() => {
    if (!isSpinning) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [isSpinning])

  const spinner = isSpinning ? SPINNER_FRAMES[frame] : ''

  const tokensStr = props.tokens !== undefined && props.windowTokens !== undefined
    ? `${props.tokens}/${props.windowTokens}`
    : ''
  // cwd 缩短为 basename（完整路径太长放不进状态栏）。
  const cwdStr = props.cwd ? props.cwd.replace(/\\/g, '/').split('/').pop() ?? props.cwd : ''

  return (
    <Box gap={1}>
      <Text backgroundColor={palette.subtext} color={meta.color}> ● </Text>
      <Text color={meta.color}>{meta.emoji}</Text>
      {isSpinning && <Text color={meta.color}>{spinner}</Text>}
      <Text bold color={meta.color}>{meta.label}</Text>
      {props.provider && props.model && <Text dimColor>· {props.provider}/{props.model}</Text>}
      {cwdStr && <Text dimColor>· {cwdStr}</Text>}
      {props.sessionId && <Text dimColor>· #{props.sessionId}</Text>}
      {tokensStr && <Text dimColor>· {tokensStr}</Text>}
    </Box>
  )
}
