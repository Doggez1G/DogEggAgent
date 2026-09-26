import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import { decisionItems } from './decisions'
import type { View } from '../../view-state'

// 权限弹层视图：工具名 + 参数 diff 预览（edit_file 显示 old→new，write_file 显示写入内容）+ 决策列表。
// 纯渲染——按键在 keys.ts。
export function PermissionOverlay({ view }: { view: Extract<View, { kind: 'permission' }> }) {
  const inp = view.input as Record<string, unknown> | null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>工具 {view.tool} 请求权限</Text>
      {view.tool === 'edit_file' && inp && (
        <Box flexDirection="column">
          <Text dimColor>文件：{String(inp.path ?? '')}</Text>
          <Text color={palette.red}>- {String(inp.old_string ?? '').slice(0, 200)}</Text>
          <Text color={palette.green}>+ {String(inp.new_string ?? '').slice(0, 200)}</Text>
        </Box>
      )}
      {view.tool === 'write_file' && inp && (
        <Box flexDirection="column">
          <Text dimColor>文件：{String(inp.path ?? '')}</Text>
          <Text color={palette.green} wrap="truncate">+ {String(inp.content ?? '').slice(0, 200)}</Text>
        </Box>
      )}
      {view.tool === 'shell' && inp && (
        <Text dimColor>命令：{String(inp.command ?? '')}</Text>
      )}
      {decisionItems(view.alwaysScope?.pattern).map((item, i) => (
        // desc 补充说明渲染为弱化色次行（仅 scoped 档有）——覆盖面须在确认前向用户言明。
        <React.Fragment key={item.decision}>
          <Text inverse={i === view.cursor}>{i === view.cursor ? '> ' : '  '}{item.label}</Text>
          {item.desc && <Text dimColor>　  {item.desc}</Text>}
        </React.Fragment>
      ))}
      <Text dimColor>↑↓ 选择 · 回车确认 · esc 拒绝</Text>
    </Box>
  )
}
