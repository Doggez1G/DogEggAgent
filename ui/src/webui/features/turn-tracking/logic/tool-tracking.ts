import type { AgentToUiMessage } from '@dogegg/bridge'
import type { FileTouched } from '../../../view-state'

// 工具调用追踪的纯逻辑（无 React 依赖，可单测）。
// permission_request.id 与 tool_start.id 不同（后端分别生成），决策按 toolName 关联。

export type ToolDecision = 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject'

export interface ToolCallEntry {
  id: string
  name: string
  status: 'running' | 'done' | 'error' | 'rejected'
  output?: string
  decision?: ToolDecision
  // 生效权限快照（shared/effectivePerm 的产出）：allow（配置永久）/ always（会话提升）/ reject / ask。
  // 最终展示标签由 shared/displayPerm 决定——显式决策优先于本快照。
  perm: string
  seq: number
}

// tool_start：追加 running 条目，记录决策标签与生效权限快照（不随后续设置变化）。
export function applyToolStart(
  prev: ToolCallEntry[],
  msg: Extract<AgentToUiMessage, { type: 'tool_start' }>,
  decision: ToolDecision | undefined,
  perm: string,
  seq: number,
): ToolCallEntry[] {
  return [...prev, { id: msg.id, name: msg.name, status: 'running', seq, decision, perm }]
}

// tool_end：有 tool_start 的正常更新状态；孤儿 end（无配对 tool_start，R3 拒绝路径只发 end）
// 兜底建条目——denied 标 rejected，其他错误标 error（见 applyToolEnd 尾部分支）。
export function applyToolEnd(
  prev: ToolCallEntry[],
  msg: Extract<AgentToUiMessage, { type: 'tool_end' }>,
  perm: string,
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
      // perm 以执行结束时的快照为准——tool_start 与 tool_end 之间可能发生会话提升
      //（如首个 ask 工具被 allow_always，镜像在决策时乐观更新，end 时已就绪）。
      perm,
      // 保留 tool_start 时记录的 decision——仅在拒绝时覆盖为 'reject'。
      decision: isRejected ? 'reject' : existing.decision,
    }
    return updated
  }
  // 孤儿 end（无前置 tool_start）：R3——拒绝也发 tool_end，让 UI 能渲染 denied。
  // denied → rejected（决策记 reject）；其他错误 → error（并非用户决策，不标 decision，
  // 展示层回落 perm 快照）；无 error 的孤儿兜底 done。
  return [...prev, {
    id: msg.id,
    name: msg.name,
    status: isRejected ? 'rejected' : msg.error ? 'error' : 'done',
    output: msg.output,
    ...(isRejected ? { decision: 'reject' as const } : {}),
    perm,
    seq,
  }]
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
