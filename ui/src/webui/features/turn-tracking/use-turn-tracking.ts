import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentToUiMessage, Config, ToolIdentity, UiPort } from '@dogegg/bridge'
import { effectivePerm } from '../../../shared'
import { applyToolStart, applyToolEnd, extractFilesTouched, shouldClearPendingTool, type ToolCallEntry, type ToolDecision } from './logic/tool-tracking'
import type { FileTouched } from '../../view-state'

// 工具执行与审批生命周期：toolCalls 追踪、filesTouched 提取、权限挂起与决策关联。
// 独立订阅 port——只关心 permission_request / tool_start / tool_end / session_ready / history_cleared / error。
export function useTurnTracking(port: UiPort): {
  toolCalls: ToolCallEntry[]
  filesTouched: FileTouched[]
  pendingPermission: { id: string; tool: string; input: unknown; alwaysScope?: { pattern: string } } | null
  resolve(id: string, tool: string, decision: ToolDecision, scopePattern?: string): void
  recordSubmit(text: string): void
  retryText: string | null
  pendingTool: string | null
  consumeRetry(): void
} {
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([])
  const [filesTouched, setFilesTouched] = useState<FileTouched[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ id: string; tool: string; input: unknown; alwaysScope?: { pattern: string } } | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  // 模型正在生成工具调用参数（tool_pending → tool_start）——供 InfoPanel 与聊天区显示准备中提示。
  const [pendingTool, setPendingTool] = useState<string | null>(null)
  // 会话内提升规则表的本地镜像（permissions_list 广播的副本：tool → patterns，空 = 整工具）。
  // 供 effectivePerm 区分「配置永久 allow」与「会话提升 always/scoped」的展示来源。
  const sessionRules = useRef<Map<string, string[]>>(new Map())
  const toolSeqRef = useRef(0)
  // 记录 permission_decision 的 toolName→decision 映射，供 tool_start 时关联决策标签。
  const permissionDecisions = useRef<Map<string, ToolDecision>>(new Map())
  // 追踪最新 config——onMessage 闭包不能直接读 config state（不在 effect deps 中）。
  const configRef = useRef<Config | null>(null)
  // 工具身份镜像（tools_list 广播）——effectivePerm 判定 MCP 服务键规则必需（服务键按身份命中）。
  const identitiesRef = useRef<Map<string, ToolIdentity>>(new Map())
  const lastSubmitText = useRef<string>('')
  // pendingPermission 的 ref 镜像——订阅回调是首渲染闭包，读 state 恒为 null（分支永不生效）。
  const pendingRef = useRef<{ id: string; tool: string; input: unknown; alwaysScope?: { pattern: string } } | null>(null)

  useEffect(() => {
    // 挂载即同步会话提升集与工具身份镜像——浏览器刷新后镜像为空，需要从后端播种。
    port.post({ type: 'permissions_request' })
    port.post({ type: 'tools_request' })
    const off = port.onMessage((msg: AgentToUiMessage) => {
      if (msg.type === 'tool_pending') { setPendingTool(msg.name); return }
      if (msg.type === 'tools_list') {
        identitiesRef.current = new Map(msg.tools.map((t) => [t.name, t.identity]))
        return
      }
      if (msg.type === 'config_state' || msg.type === 'config_updated') {
        configRef.current = msg.config
      } else if (msg.type === 'permission_request') {
        pendingRef.current = { id: msg.id, tool: msg.tool, input: msg.input, alwaysScope: msg.alwaysScope }
        setPendingPermission(pendingRef.current)
      } else if (msg.type === 'state') {
        // 权限等待期间状态离开 waiting_permission（如 cancel）→ 关闭审批横幅。
        if (msg.to !== 'waiting_permission' && pendingRef.current) {
          pendingRef.current = null
          setPendingPermission(null)
        }
        // 状态迁移到非 running 态（idle/finished/cancelled/error）时清「调用中…」占位——
        // pendingTool 原先只在 tool_start/session_ready 清除，中断/出错后右栏会永久残留转圈行。
        if (shouldClearPendingTool(msg.to)) setPendingTool(null)
      } else if (msg.type === 'session_ready') {
        setFilesTouched([])
        toolSeqRef.current = 0
        setPendingTool(null)
        // 会话隔离：retryText 是上一轮 error 的回填文本，跨会话残留会在新会话首帧误回填——一并清空。
        setRetryText(null)
        // 会话隔离：提升集随会话存档恢复——先清空镜像，再从后端重新播种。
        sessionRules.current.clear()
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
        const perm = effectivePerm(configRef.current?.permission ?? { allow: {}, reject: {}, ask: {} }, msg.name, sessionRules.current, identitiesRef.current)
        setToolCalls((prev) => applyToolStart(prev, msg, decision, perm, seq))
        // 用完后清除 decision（避免下一个同名工具继承上次决策）。
        if (decision) permissionDecisions.current.delete(msg.name)
        // 提升决策后刷新 Session Permissions 列表——tool_start 到达时 permission.apply 已执行。
        if (decision === 'allow_always' || decision === 'allow_always_scoped') port.post({ type: 'permissions_request' })
        const touched = extractFilesTouched(msg)
        if (touched) setFilesTouched((prev) => [...prev, touched])
      } else if (msg.type === 'tool_end') {
        setToolCalls((prev) => applyToolEnd(prev, msg, effectivePerm(configRef.current?.permission ?? { allow: {}, reject: {}, ask: {} }, msg.name, sessionRules.current, identitiesRef.current), ++toolSeqRef.current))
      } else if (msg.type === 'permissions_list') {
        // 会话提升集的后端广播——镜像的权威同步点（挂载/会话切换播种、决策后刷新都走这里）。
        sessionRules.current = new Map(msg.permissions.map((p) => [p.tool, p.patterns]))
      } else if (msg.type === 'error') {
        // 出错时自动回填上次提交的文本到输入框，方便重试（与 TUI 行为一致）。
        if (lastSubmitText.current) setRetryText(lastSubmitText.current)
        // 出错即本轮终止——清「调用中…」占位，避免右栏残留转圈行（与 state 非 running 分支同理）。
        setPendingTool(null)
      } else if (msg.type === 'finished') {
        // 正常收尾——同样清「调用中…」占位（finished 不带 state 迁移消息的传输时序下兜底）。
        setPendingTool(null)
      }
    })
    return off
    // pendingPermission 通过 ref 闭包读取——用 state 会在 effect deps 中失效。
  }, [port])

  // 决议提交的序号——迟到的 Promise 失败（期间用户已重试成功）据此判断是否还该回滚。
  const resolveSeqRef = useRef(0)

  const resolve = useCallback((id: string, tool: string, decision: ToolDecision, scopePattern?: string) => {
    const seq = ++resolveSeqRef.current
    // 快照决议前的可变状态——提交失败时按原样回滚（横幅重现可重试、镜像还原、决策标签还原）。
    const prevRules = new Map(sessionRules.current)
    const prevDecision = permissionDecisions.current.get(tool)
    const pending = pendingRef.current
    permissionDecisions.current.set(tool, decision)
    // 乐观更新提升镜像——提升在 permission.apply 即刻生效，不等 permissions_list 往返，
    // 同轮内后续同范围工具的 tool_start 就能按 always/scoped 展示（随后端广播校正）。
    if (decision === 'allow_always') sessionRules.current.set(tool, [])
    else if (decision === 'allow_always_scoped' && scopePattern) {
      const cur = sessionRules.current.get(tool)
      if (!cur || cur.length > 0) sessionRules.current.set(tool, cur && !cur.includes(scopePattern) ? [...cur, scopePattern] : cur ?? [scopePattern])
    }
    if (decision === 'allow_always' || decision === 'allow_always_scoped') port.post({ type: 'permissions_request' })
    pendingRef.current = null
    // 失败回滚（与 app 层 safePost 同款安全提交语义）：先清横幅再裸 post 的旧时序下，POST 失败
    // 会导致横幅消失而后端永久等待 decision——这里恢复原请求对象让横幅重现、用户可重试。
    const rollback = (e: unknown): void => {
      // 迟到的失败：期间已有更新的决议提交（seq 变化）则不再回滚，避免复活过期的横幅。
      if (resolveSeqRef.current !== seq) {
        console.warn('[turn-tracking] permission_decision 提交失败（已有更新的提交，跳过回滚）', e)
        return
      }
      console.warn('[turn-tracking] permission_decision 提交失败，已恢复审批横幅可重试', e)
      sessionRules.current = prevRules
      if (prevDecision === undefined) {
        if (permissionDecisions.current.get(tool) === decision) permissionDecisions.current.delete(tool)
      } else {
        permissionDecisions.current.set(tool, prevDecision)
      }
      pendingRef.current = pending
      setPendingPermission(pending)
    }
    try {
      const posted = port.post({ type: 'permission_decision', id, decision })
      if (posted instanceof Promise) posted.catch(rollback)
    } catch (e) {
      rollback(e)
      return
    }
    setPendingPermission(null)
  }, [port])

  const recordSubmit = useCallback((text: string) => { lastSubmitText.current = text }, [])

  return { toolCalls, filesTouched, pendingPermission, resolve, recordSubmit, retryText, consumeRetry: () => setRetryText(null), pendingTool }
}
