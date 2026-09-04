import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 消息卡片系统——统一结构语言：每类消息 = 左竖线 + 背景容器，色彩区分角色：
//   user:      accent 蓝  竖线 + surface 背景    （你说话）
//   assistant: 无容器正文（最大阅读区，内联 🐶 前缀）
//   thinking:  purple 紫竖线 + surfaceAlt 背景  （思考卡片）
//   tool:      cyan 青竖线  + surfaceAlt 背景    （工具卡片）
//   error:     red 红竖线   + surface 背景
//   notice / auto_compact: faint 裸文本（最弱）
// 展开由 expanded 控制——切换时 App 清屏重挂 Static 重绘。
export function MessageBlock(props: { block: Block; expanded?: boolean }) {
  const b = props.block
  const expanded = props.expanded ?? false
  return (
    <Box flexDirection="column" marginBottom={1}>
      {renderBlock(b, expanded)}
    </Box>
  )
}

// 左竖线卡片容器：只有左边框（round 风格的 │），配背景色。
function Card(props: { color: string; bg: string; children: React.ReactNode }) {
  return (
    <Box
      borderStyle="round"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={props.color}
      backgroundColor={props.bg}
      paddingX={1}
    >
      {props.children}
    </Box>
  )
}

function renderBlock(b: Block, expanded: boolean): React.ReactNode {
  switch (b.kind) {
    case 'user':
      return (
        <Card color={palette.accent} bg={palette.surface}>
          <Text>🥚 {b.text}</Text>
        </Card>
      )
    case 'assistant': {
      // 首行内联 🐶 前缀（accent 色），正文 markdown 富文本。
      const lines = b.text.split('\n')
      const first = lines[0] ?? ''
      const rest = lines.slice(1)
      return (
        <>
          <Text>
            <Text color={palette.accent}>🐶 </Text>
            <Text>{first}</Text>
          </Text>
          {rest.length > 0 && <Text>{rest.join('\n')}</Text>}
        </>
      )
    }
    case 'thinking': {
      const full = b.full ?? b.text
      return (
        <Card color={palette.purple} bg={palette.surfaceAlt}>
          {expanded ? (
            <>
              <Text color={palette.purple}>🐣 思考（展开）</Text>
              <Text color={palette.subtext}>{full}</Text>
            </>
          ) : (
            <Text color={palette.subtext}>🐣 思考 · {full.length} 字</Text>
          )}
        </Card>
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
      return (
        <Card color={palette.cyan} bg={palette.surfaceAlt}>
          {expanded && b.full ? (
            <>
              {head}
              {(() => {
                const clipped = b.full.split('\n').slice(1)
                const truncated = clipped.length > 50
                return (
                  <>
                    {clipped.slice(0, 50).map((l, i) => (
                      <Text key={i} color={palette.subtext}>⎿ {l}</Text>
                    ))}
                    {truncated && <Text color={palette.faint}>…（共 {clipped.length} 行，完整输出见 /log）</Text>}
                  </>
                )
              })()}
            </>
          ) : (
            <>
              {head}
              {summaryLines.slice(1).map((l, i) => (
                <Text key={i} color={palette.subtext}>⎿ {truncateMiddle(l, 100)}</Text>
              ))}
            </>
          )}
        </Card>
      )
    }
    case 'error':
      return (
        <Card color={palette.red} bg={palette.surface}>
          <Text color={palette.red}>✕ {b.text}</Text>
        </Card>
      )
    case 'auto_compact':
      return <Text color={palette.faint}>🥚 {b.text}</Text>
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
