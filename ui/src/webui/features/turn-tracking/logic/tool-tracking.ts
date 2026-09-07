import type { AgentToUiMessage } from '@dogegg/bridge'
import type { FileTouched } from '../../../app/view-state'

// 工具调用追踪的纯逻辑（无 React 依赖，可单测）。
// permission_request.id 与 tool_start.id 不同（后端分别生成），决策按 toolName 关联。

export type ToolDecision = 'allow_once' | 'allow_always' | 'reject'

export interface ToolCallEntry {
  id: string
  name: string
  status: 'running' | 'done' | 'error' | 'rejected'
  output?: string
  decision?: ToolDecision
  configPerm: string
  seq: number
}

// tool_start：追加 running 条目，记录决策标签与配置权限快照（不随后续设置变化）。
export function applyToolStart(
  prev: ToolCallEntry[],
  msg: Extract<AgentToUiMessage, { type: 'tool_start' }>,
  decision: ToolDecision | undefined,
  configPerm: string,
  seq: number,
): ToolCallEntry[] {
  return [...prev, { id: msg.id, name: msg.name, status: 'running', seq, decision, configPerm }]
}

// tool_end：有 tool_start 的正常更新状态；孤儿 end（被拒绝/未知工具）创建 rejected 条目。
export function applyToolEnd(
  prev: ToolCallEntry[],
  msg: Extract<AgentToUiMessage, { type: 'tool_end' }>,
  configPerm: string,
  seq: number,
): ToolCallEntry[] {
  // 检测是否是被拒绝的工具——error === 'denied' 表示拒绝（无前置 tool_start）。
  const isRejected = msg.error === 'denied'
  const idx = prev.findIndex((tc) => tc.id === msg.id)
  if (idx >= 0) {
    const existing = prev[idx]!
    const updated = [...prev]
    updated[idx] = {
      ...existing,
      status: isRejected ? 'rejected' : (msg.error ? 'error' : 'done'),
      output: msg.output,
      // 保留 tool_start 时记录的 decision——仅在拒绝时覆盖为 'reject'。
      decision: isRejected ? 'reject' : existing.decision,
    }
    return updated
  }
  return [...prev, { id: msg.id, name: msg.name, status: 'rejected', output: msg.output, decision: 'reject', configPerm, seq }]
}

// Files Touched：从 tool_start 的 input 提取文件路径（仅 edit_file / write_file）。
export function extractFilesTouched(
  msg: Extract<AgentToUiMessage, { type: 'tool_start' }>,
): FileTouched | null {
  if (msg.name !== 'edit_file' && msg.name !== 'write_file') return null
  if (!msg.input) return null
  const inp = msg.input as Record<string, unknown>
  const path = String(inp.path ?? '')
  if (!path) return null
  return {
    path,
    action: msg.name === 'edit_file' ? 'edit' : 'write',
    toolName: msg.name,
    time: Date.now(),
  }
}
