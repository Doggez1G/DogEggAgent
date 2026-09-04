import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 品牌消息渲染（OpenCode 式明度分层 + 蛋狗家族 emoji）：
//   user:      全宽 surface 背景块 + accent 实色竖线 + 🥚 前缀——轮次强边界
//   assistant: 无背景纯文本（markdown 富文本）——与背景块形成明暗对比
//   thinking:  🐣 思考 · N 字（黄 emoji + dim 元信息）／展开显示全文
//   tool:      全宽 surface 背景块 + cyan 实色竖线 + 🐾 调用行／展开输出在块内
//   error:     ✕ 红
//   notice / auto_compact: · dim
// 竖线用 ▌（左半块字符）实色渲染——比边框线更粗、更现代（OpenCode 同款）。
// 折叠/展开由 expanded prop 控制——切换时 App 清屏并重挂 Static 重绘全部块。
export function MessageBlock(props: { block: Block; expanded?: boolean }) {
  const b = props.block
  const expanded = props.expanded ?? false
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderBlock(b, expanded)}
    </Box>
  )
}

// 带竖线的背景块：左列竖线 + 右列内容（背景延伸到全宽）。
function RailBlock(props: { rail: string; bg: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text color={props.rail}>▌</Text>
      <Box flexDirection="column" backgroundColor={props.bg} paddingX={1} flexGrow={1}>
        {props.children}
      </Box>
    </Box>
  )
}

function renderBlock(b: Block, expanded: boolean): React.ReactNode {
  switch (b.kind) {
    case 'user':
      return (
        <RailBlock rail={palette.accent} bg={palette.surface}>
          <Text>🥚 {b.text}</Text>
        </RailBlock>
      )
    case 'assistant':
      // 无背景纯文本——与 user/tool 的背景块形成明暗节奏。
      return <Text>{b.text}</Text>
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        return (
          <Text>
            <Text>🐣 </Text>
            <Text color={palette.subtext}>思考 · {full.length} 字</Text>
          </Text>
        )
      }
      return (
        <>
          <Text>🐣 <Text color={palette.yellow}>思考（展开）</Text></Text>
          <Text dimColor>{full}</Text>
        </>
      )
    }
    case 'tool': {
      // text 首行是调用（name + args JSON），其余是结果摘要。
      const lines = b.text.split('\n')
      const callLine = lines[0] ?? ''
      const callName = callLine.split(' ')[0] ?? '工具'
      const callArgs = truncateMiddle(callLine.slice(callName.length).trim(), 70)
      const summaryLines = lines.slice(1)
      const head = (
        <Text>
          <Text color={palette.cyan}>🐾 {callName}</Text>
          <Text color={palette.subtext}>({callArgs})</Text>
          {summaryLines.length > 0 && <Text color={palette.subtext}> · {truncateMiddle(summaryLines[0]!.replace(/^[✓✕] /, ''), 50)}</Text>}
        </Text>
      )
      if (!expanded || !b.full) {
        return (
          <RailBlock rail={palette.cyan} bg={palette.surface}>
            {head}
            {summaryLines.slice(1).map((l, i) => (
              <Text key={i} color={palette.subtext}>⎿ {truncateMiddle(l, 100)}</Text>
            ))}
          </RailBlock>
        )
      }
      // 展开：完整结果/diff 在背景块内（超长截断到 50 行）。
      const fullLines = b.full.split('\n')
      const clipped = fullLines.slice(1) // 跳过调用行
      const truncated = clipped.length > 50
      return (
        <RailBlock rail={palette.cyan} bg={palette.surface}>
          {head}
          <Text color={palette.yellow}>↑ 已展开</Text>
          {clipped.slice(0, 50).map((l, i) => (
            <Text key={i} color={palette.subtext}>⎿ {l}</Text>
          ))}
          {truncated && <Text color={palette.subtext}>…（共 {clipped.length} 行，完整输出见 /log）</Text>}
        </RailBlock>
      )
    }
    case 'error':
      return (
        <>
          <Text color={palette.red}>✕ 出错了</Text>
          <Text color={palette.red}>{b.text}</Text>
        </>
      )
    case 'auto_compact':
      return <Text color={palette.subtext}>🥚 {b.text}</Text>
    default: // notice
      return <Text color={palette.subtext}>· {b.text}</Text>
  }
}

// 中间截断：保留头尾，中间以 … 代替（比尾部截断保留更多信息）。
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.slice(0, half) + '…' + s.slice(s.length - half)
}
