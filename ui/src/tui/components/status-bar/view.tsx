import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import { isStateRunning } from '../../../shared'
import { COMPACTION_THRESHOLD } from '@dogegg/bridge'
import type { State } from '@dogegg/bridge'

// Braille spinner 帧序列——10 帧循环，80ms/帧（12.5fps），完整一圈 800ms。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 状态 → (Emoji, 中文描述) 映射（颜色主题相关，渲染时经 stateColor() 动态取）。
const STATE_META: Record<string, { emoji: string; label: string }> = {
  idle: { emoji: '🥚', label: '空闲' },
  thinking: { emoji: '🐣', label: '思考中' },
  responding: { emoji: '🐶', label: '回答中' },
  tool_calling: { emoji: '🐾', label: '工具调用' },
  executing: { emoji: '🐾', label: '执行中' },
  waiting_permission: { emoji: '⚠', label: '等待审批' },
  finished: { emoji: '🐥', label: '完成' },
  cancelled: { emoji: '🥚', label: '已打断' },
  error: { emoji: '🐶', label: '出错' },
  compacting: { emoji: '🥚', label: '压缩中' },
}

// 状态色（渲染时动态读主题——模块级常量会固化 Proxy 首值，切主题不跟色）。
function stateColor(state: string): string {
  switch (state) {
    case 'thinking': case 'waiting_permission': return palette.yellow
    case 'responding': return palette.accent
    case 'tool_calling': case 'executing': case 'compacting': return palette.cyan
    case 'finished': return palette.green
    case 'error': return palette.red
    default: return palette.subtext
  }
}

// context 进度条：8 格块字符，超过压缩阈值时变黄提示。
function contextBar(tokens?: number, windowTokens?: number): { bar: string; color: string; text: string } | null {
  if (tokens === undefined || windowTokens === undefined || windowTokens <= 0) return null
  const ratio = Math.min(1, tokens / windowTokens)
  const filled = Math.round(ratio * 8)
  const bar = '█'.repeat(filled) + '░'.repeat(8 - filled)
  const over = ratio >= COMPACTION_THRESHOLD
  return { bar, color: over ? palette.yellow : palette.subtext, text: `${fmtTokens(tokens)}/${fmtTokens(windowTokens)}` }
}

// token 数格式化：1e6+ → M，1e3+ → k，其余原样。
function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

// 状态栏：Emoji + spinner + 状态 + provider/model + context 进度条 + cwd + session。
// 运行态显示 spinner 旋转动画，非运行态静态显示。
export function StatusBar(props: {
  state: string
  provider?: string
  model?: string
  sessionId?: string
  tokens?: number
  windowTokens?: number
  cwd?: string
}) {
  const meta = STATE_META[props.state] ?? { emoji: '🥚', label: props.state }
  const metaColor = stateColor(props.state)
  const isSpinning = isStateRunning(props.state as State)
  const [frame, setFrame] = useState(0)

  // 运行态启动定时器切换 spinner 帧，非运行态停止——避免不必要重渲染。
  useEffect(() => {
    if (!isSpinning) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [isSpinning])

  const spinner = isSpinning ? SPINNER_FRAMES[frame] : ''
  const ctx = contextBar(props.tokens, props.windowTokens)
  // cwd 缩短为 basename（完整路径太长放不进状态栏）。
  const cwdStr = props.cwd ? props.cwd.replace(/\\/g, '/').split('/').pop() ?? props.cwd : ''
  const modelStr = props.provider && props.model ? `${props.provider}/${props.model}` : ''

  return (
    <Box gap={1}>
      {/* 状态词背景徽章：运行时黄底深字（醒目），空闲/结束 surface 底（安静） */}
      <Text backgroundColor={isSpinning ? palette.yellow : palette.surfaceAlt} color={isSpinning ? '#1e2030' : metaColor}> {meta.emoji} {isSpinning ? spinner + ' ' : ''}{meta.label} </Text>
      {modelStr && <Text color={palette.subtext}>· {modelStr}</Text>}
      {ctx && <Text color={ctx.color}>· [{ctx.bar}] {ctx.text}</Text>}
      {cwdStr && <Text color={palette.subtext}>· 📂 {cwdStr}</Text>}
      {props.sessionId && <Text color={palette.faint}>· 🔖 {props.sessionId.slice(0, 8)}</Text>}
    </Box>
  )
}
