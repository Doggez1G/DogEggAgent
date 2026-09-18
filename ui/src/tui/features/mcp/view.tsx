import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { McpServerEntry } from '../../view-state'

// MCP 管理面板：server 列表（配置 + 运行时状态）+ 按键提示。
// 状态着色：running 绿 / starting 黄 / error 红 / stopped 灰。纯渲染——按键在 keys.ts。
const STATUS_META: Record<McpServerEntry['status'], { label: string; color: string }> = {
  running: { label: '运行中', color: palette.green },
  starting: { label: '启动中', color: palette.yellow },
  error: { label: '出错', color: palette.red },
  stopped: { label: '已停用', color: palette.subtext },
}

export function McpPanel({ view }: { view: Extract<import('../../view-state').View, { kind: 'mcp' }> }) {
  const { servers, cursor } = view
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>MCP Servers 管理</Text>
      {servers.length === 0 && <Text dimColor>（还没有 server——按 a 添加，或在 .dogegg/.mcp.json / 配置文件里配置）</Text>}
      {servers.map((s, i) => {
        const meta = STATUS_META[s.status]
        const active = i === cursor
        return (
          <Box key={s.name} flexDirection="column">
            <Text inverse={active} color={active ? undefined : palette.subtext} wrap="truncate">
              {active ? '> ' : '  '}{s.enabled ? '' : '[停用] '}{s.name}（{s.scope} · {s.transport.type}）{meta ? ` — ${meta.label}` : ''} · {s.tools.length} 个工具
            </Text>
            {s.error && <Text color={palette.red} wrap="truncate">    ↳ {s.error}</Text>}
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择 · Enter 详情 · a 新建 · e 编辑 · t 启停 · d 删除 · esc 返回</Text>
      </Box>
    </Box>
  )
}
