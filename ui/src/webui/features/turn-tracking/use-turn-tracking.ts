import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import { effectivePerm } from '../../../shared'
import { applyToolStart, applyToolEnd, extractFilesTouched, type ToolCallEntry, type ToolDecision } from './logic/tool-tracking'
import type { FileTouched } from '../../view-state'

// 工具执行与审批生命周期：toolCalls 追踪、filesTouched 提取、权限挂起与决策关联。
// 独立订阅 port——只关心 permission_request / tool_start / tool_end / session_ready / history_cleared / error。
export function useTurnTracking(port: UiPort): {
  toolCalls: ToolCallEntry[]
  filesTouched: FileTouched[]
  pendingPermission: { id: string; tool: string; input: unknown } | null
  resolve(id: string, tool: string, decision: ToolDecision): void
  recordSubmit(text: string): void
  retryText: string | null
  pendingTool: string | null
  consumeRetry(): void
} {
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([])
  const [filesTouched, setFilesTouched] = useState<FileTouched[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ id: string; tool: string; input: unknown } | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  // 模型正在生成工具调用参数（tool_pending → tool_start）——供 InfoPanel 与聊天区显示准备中提示。
  const [pendingTool, setPendingTool] = useState<string | null>(null)
  // 会话内 allow_always 提升工具集的本地镜像（permissions_list 广播的副本）。
  // 供 effectivePerm 区分「配置永久 allow」与「会话提升 always」的展示来源。
  const sessionAllowed = useRef<Set<string>>(new Set())
  const toolSeqRef = useRef(0)
  // 记录 permission_decision 的 toolName→decision 映射，供 tool_start 时关联决策标签。
  const permissionDecisions = useRef<Map<string, ToolDecision>>(new Map())
  // 追踪最新 config——onMessage 闭包不能直接读 config state（不在 effect deps 中）。
  const configRef = useRef<Config | null>(null)
  const lastSubmitText = useRef<string>('')
  // pendingPermission 的 ref 镜像——订阅回调是首渲染闭包，读 state 恒为 null（分支永不生效）。
  const pendingRef = useRef<{ id: string; tool: string; input: unknown } | null>(null)

  useEffect(() => {
    // 挂载即同步会话提升集——浏览器刷新后镜像为空，需要从后端播种。
    port.post({ type: 'permissions_request' })
    const off = port.onMessage((msg: AgentToUiMessage) => {
      if (msg.type === 'tool_pending') { setPendingTool(msg.name); return }
      if (msg.type === 'config_state' || msg.type === 'config_updated') {
        configRef.current = msg.config
      } else if (msg.type === 'permission_request') {
        pendingRef.current = { id: msg.id, tool: msg.tool, input: msg.input }
        setPendingPermission(pendingRef.current)
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && pendingRef.current) {
        // 权限等待期间状态离开 waiting_permission（如 cancel）→ 关闭审批横幅。
        pendingRef.current = null
        setPendingPermission(null)
      } else if (msg.type === 'session_ready') {
        setFilesTouched([])
        toolSeqRef.current = 0
        setPendingTool(null)
        // 会话隔离：提升集随会话存档恢复——先清空镜像，再从后端重新播种。
        sessionAllowed.current.clear()
        port.post({ type: 'permissions_request' })
        setToolCalls([])
      } else if (msg.type === 'history_cleared') {
        setFilesTouched([])
        setToolCalls([])
      } else if (msg.type === 'tool_start') {
        setPendingTool(null)
        const seq = ++toolSeqRef.current
        // 按 toolName 查找 decision——permission_request.id 与 tool_start.id 不同。
        const decision = permissionDecisions.current.get(msg.name)
        // 记录执行时的生效权限快照（区分配置 allow 与会话提升 always）——不随后续设置变化。
        const perm = effectivePerm(configRef.current?.permission ?? { allow: [], reject: [], ask: [] }, msg.name, sessionAllowed.current)
        setToolCalls((prev) => applyToolStart(prev, msg, decision, perm, seq))
        // 用完后清除 decision（避免下一个同名工具继承上次决策）。
        if (decision) permissionDecisions.current.delete(msg.name)
        // allow_always 决策后刷新 Session Permissions 列表——tool_start 到达时 permission.apply 已执行。
        if (decision === 'allow_always') port.post({ type: 'permissions_request' })
        const touched = extractFilesTouched(msg)
        if (touched) setFilesTouched((prev) => [...prev, touched])
      } else if (msg.type === 'tool_end') {
        setToolCalls((prev) => applyToolEnd(prev, msg, effectivePerm(configRef.current?.permission ?? { allow: [], reject: [], ask: [] }, msg.name, sessionAllowed.current), ++toolSeqRef.current))
      } else if (msg.type === 'permissions_list') {
        // 会话提升集的后端广播——镜像的权威同步点（挂载/会话切换播种、决策后刷新都走这里）。
        sessionAllowed.current = new Set(msg.tools)
      } else if (msg.type === 'error') {
        // 出错时自动回填上次提交的文本到输入框，方便重试（与 TUI 行为一致）。
        if (lastSubmitText.current) setRetryText(lastSubmitText.current)
      }
    })
    return off
    // pendingPermission 通过 ref 闭包读取——用 state 会在 effect deps 中失效。
  }, [port])

  const resolve = useCallback((id: string, tool: string, decision: ToolDecision) => {
    permissionDecisions.current.set(tool, decision)
    // 乐观更新提升镜像——allow_always 在 permission.apply 即刻生效，
    // 不等 permissions_list 往返，同轮内后续同名工具的 tool_start 就能按 always 展示。
    if (decision === 'allow_always') sessionAllowed.current.add(tool)
    pendingRef.current = null
    port.post({ type: 'permission_decision', id, decision })
    setPendingPermission(null)
  }, [port])

  const recordSubmit = useCallback((text: string) => { lastSubmitText.current = text }, [])

  return { toolCalls, filesTouched, pendingPermission, resolve, recordSubmit, retryText, consumeRetry: () => setRetryText(null), pendingTool }
}
