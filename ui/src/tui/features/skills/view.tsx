import React from 'react'
import { Box, Text } from 'ink'
import { palette } from '../../theme'
import type { SkillEntry } from '../../view-state'

// Skills 管理面板：项目级/用户级分组列表 + 按键提示。
// 纯渲染——按键在 keys.ts；增改的输入流经 prompt 弹层（returnView 回本面板）。
export function SkillsPanel({ view }: { view: Extract<import('../../view-state').View, { kind: 'skills' }> }) {
  const { skills, cursor } = view
  const groups: { label: string; scope: 'project' | 'user' }[] = [
    { label: '项目级（.dogegg/skills）', scope: 'project' },
    { label: '用户级（~/.dogegg/skills）', scope: 'user' },
  ]
  let flat = -1 // 渲染游标——组标题行不占 cursor，条目行对应 skills 数组下标
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text bold color={palette.accent}>Skills 管理</Text>
      {skills.length === 0 && <Text dimColor>（还没有 skill——按 a 新建，或往目录里放 SKILL.md）</Text>}
      {groups.map((g) => {
        const items = skills.filter((s) => s.scope === g.scope)
        if (items.length === 0) return null
        return (
          <Box key={g.scope} flexDirection="column" marginTop={1}>
            <Text color={palette.faint}>── {g.label} ──</Text>
            {items.map((s) => {
              flat++
              const active = flat === cursor
              return (
                <Text key={`${s.scope}/${s.name}`} inverse={active} color={active ? undefined : palette.subtext} wrap="truncate">
                  {active ? '> ' : '  '}{s.name}{s.description ? ` — ${s.description}` : ''}
                </Text>
              )
            })}
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Text dimColor>↑↓ 选择 · Enter 详情 · a 新建 · e 编辑 · d 删除 · esc 返回</Text>
      </Box>
    </Box>
  )
}
