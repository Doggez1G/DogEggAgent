import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { Block } from '../../../shared/block'

// DogEgg 消息块系统——头行在上、内容整体缩进在下，全块统一容器：
//
//   ▌🥚 你                    ← 头行：实色竖条(角色色) + emoji + 名称
//     你好，帮我看看结构        ← 内容整体缩进 2 格（同背景）
//
// 五色角色系统（▌竖条色）：
//   accent 蓝=你  green 绿=DogEgg  purple 紫=思考  cyan 青=工具  red 红=错误
// 背景两档：surface（user/assistant/error）、surfaceAlt（thinking/tool）。
// assistant 也容器化（与其它块同构）；notice/auto_compact 保持 faint 裸文本。
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

// 块容器：头行（▌ + label）在上，内容整体缩进在下，背景贯穿全宽。
// collapsed=true 时只有头行一行（无内容区）。
function BlockShell(props: { color: string; bg: string; label: React.ReactNode; children?: React.ReactNode; collapsed?: boolean }) {
  return (
    <Box flexDirection="column" backgroundColor={props.bg}>
      <Text>
        <Text color={props.color}>▌ </Text>
        {props.label}
      </Text>
      {!props.collapsed && (
        <Box paddingLeft={3} paddingRight={1}>
          {props.children}
        </Box>
      )}
    </Box>
  )
}

function renderBlock(b: Block, expanded: boolean): React.ReactNode {
  switch (b.kind) {
    case 'user':
      return (
        <BlockShell color={palette.accent} bg={palette.surface} label={<Text bold color={palette.accent}>🥚 你</Text>}>
          <Text>{b.text}</Text>
        </BlockShell>
      )
    case 'assistant':
      return (
        <BlockShell color={palette.green} bg={palette.surface} label={<Text bold color={palette.green}>🐶 DogEgg</Text>}>
          <Text>{b.text}</Text>
        </BlockShell>
      )
    case 'thinking': {
      const full = b.full ?? b.text
      if (!expanded) {
        return (
          <BlockShell color={palette.purple} bg={palette.surfaceAlt} collapsed label={<Text color={palette.subtext}>🐣 思考 · {full.length} 字（浏览模式 Enter 展开）</Text>} />
        )
      }
      return (
        <BlockShell color={palette.purple} bg={palette.surfaceAlt} label={<Text color={palette.purple}>🐣 思考（展开）</Text>}>
          <Text color={palette.subtext}>{full}</Text>
        </BlockShell>
      )
    }
    case 'tool': {
      // text 首行是调用（name + args JSON），其余是结果摘要。
      const lines = b.text.split('\n')
      const callLine = lines[0] ?? ''
      const callName = callLine.split(' ')[0] ?? '工具'
      const callArgs = truncateMiddle(callLine.slice(callName.length).trim(), 70)
      const summaryLines = lines.slice(1)
      const headLabel = (
        <Text>
          <Text color={palette.cyan}>🐾 {callName}</Text>
          <Text color={palette.subtext}>({callArgs})</Text>
          {summaryLines.length > 0 && <Text color={palette.subtext}> · {truncateMiddle(summaryLines[0]!.replace(/^[✓✕] /, ''), 50)}</Text>}
        </Text>
      )
      if (!expanded || !b.full) {
        return (
          <BlockShell color={palette.cyan} bg={palette.surfaceAlt} collapsed label={headLabel} />
        )
      }
      // 展开：头行在上，完整结果/diff 缩进在下（超长截断 50 行）。
      const clipped = b.full.split('\n').slice(1) // 跳过调用行
      const truncated = clipped.length > 50
      return (
        <BlockShell color={palette.cyan} bg={palette.surfaceAlt} label={headLabel}>
          {clipped.slice(0, 50).map((l, i) => (
            <Text key={i} color={palette.subtext}>⎿ {l}</Text>
          ))}
          {truncated && <Text color={palette.faint}>…（共 {clipped.length} 行，完整输出见 /log）</Text>}
        </BlockShell>
      )
    }
    case 'error':
      return (
        <BlockShell color={palette.red} bg={palette.surface} label={<Text color={palette.red}>✕ 出错了</Text>}>
          <Text color={palette.red}>{b.text}</Text>
        </BlockShell>
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

// 流式中的 partial 块容器——与已完成块同构（头行+缩进内容），
// 让回复/思考从一开始就有边框线，而不是完成后才出现。
// text 由调用方完成 markdown 渲染（assistant）或原文（thinking）。
export function StreamingBlock(props: { kind: 'assistant' | 'thinking'; text: string }) {
  const isThinking = props.kind === 'thinking'
  const color = isThinking ? palette.purple : palette.green
  const bg = isThinking ? palette.surfaceAlt : palette.surface
  return (
    <Box flexDirection="column" backgroundColor={bg} marginBottom={1}>
      <Text>
        <Text color={color}>▌ </Text>
        <Text color={color}>{isThinking ? '🐣 思考中…' : '🐶 DogEgg'}</Text>
      </Text>
      <Box paddingLeft={3} paddingRight={1}>
        {isThinking
          ? <Text color={palette.subtext}>{props.text}</Text>
          : <Text>{props.text}</Text>}
      </Box>
    </Box>
  )
}
