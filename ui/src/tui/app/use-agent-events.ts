import { useEffect, useRef } from 'react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import type { View } from '../view-state'

export interface StatusBarData {
  provider?: string
  model?: string
  sessionId?: string
  tokens?: number
  windowTokens?: number
  cwd?: string
}

export interface AgentEventsDeps {
  port: UiPort
  viewRef: { current: View }
  currentCwdRef: { current: string }
  /** 显式信息请求标记：/context /status 等命令置 true，回响应时打开 info overlay；轮询静默。 */
  explicitInfoRef: { current: boolean }
  /** /model vs /config 的 intent：后端回 config_state 时据此打开对应选择器。 */
  configIntentRef: { current: 'model' | 'config' | null }
  setView(view: View): void
  updateConfig(c: Config): void
  openMenu(title: string, items: { label: string; onSelect: () => void }[]): void
  openModelPicker(c: Config): void
  openConfigTree(c: Config): void
  setStatusBarData(updater: StatusBarData | ((d: StatusBarData) => StatusBarData)): void
  clearScreenRemount(): void
  /** 会话切换/清空后的 UI 复位（联想、浏览焦点、展开集合）。 */
  onSessionCleared(): void
  /** 错误自动重填上次提交文本。 */
  onErrorRetry(): void
  setInfoScroll(updater: number | ((s: number) => number)): void
}

// agent 消息的 UI 视图侧效应订阅（chat 数据域归 use-chat——两个订阅域正交）。
// actions 经 ref 读取：订阅只建立一次（重复建立会反复重发 config_request/status_request）。
export function useAgentEvents(deps: AgentEventsDeps): void {
  const ref = useRef(deps)
  useEffect(() => { ref.current = deps })

  useEffect(() => {
    const off = deps.port.onMessage((msg: AgentToUiMessage) => {
      const d = ref.current
      // 会话切换/清空：清屏 + Static 重挂载（Static 已输出的内容无法撤回）。
      if (msg.type === 'session_ready' || msg.type === 'history_cleared') {
        d.clearScreenRemount()
        d.onSessionCleared()
      }
      // 错误恢复：error 时自动预填上次提交的文本到输入框，用户可直接改或重新提交。
      if (msg.type === 'error') d.onErrorRetry()
      if (msg.type === 'permission_request') {
        d.setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, cursor: 0 })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && d.viewRef.current.kind === 'permission') {
        // 权限等待期间状态离开 waiting_permission（如 cancel）→ 关闭 permission overlay。
        d.setView({ kind: 'none' })
      } else if (msg.type === 'session_list') {
        // 按 cwd 过滤：只显示当前工作目录下的会话（Claude 式——每个目录独立）。
        // 路径归一化：统一为小写 + 正斜杠，兼容 Windows 反斜杠 + 大小写不敏感。
        const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const cwd = normalize(d.currentCwdRef.current)
        const filtered = msg.sessions.filter((s) => normalize(s.cwd ?? '') === cwd)
        d.setView({ kind: 'sessionPicker', sessions: filtered.map((s) => ({ id: s.id, preview: s.preview || '（空会话）', updatedAt: s.updatedAt })), cursor: 0, query: '' })
      } else if (msg.type === 'session_deleted') {
        // 会话删除后刷新列表——重新请求 session_list（会触发 sessionPicker 重建）。
        d.port.post({ type: 'list_sessions' })
      } else if (msg.type === 'config_state') {
        d.updateConfig(msg.config)
        if (d.configIntentRef.current === 'model') { d.openModelPicker(msg.config); d.configIntentRef.current = null }
        else if (d.configIntentRef.current === 'config') { d.openConfigTree(msg.config); d.configIntentRef.current = null }
      } else if (msg.type === 'config_updated') {
        d.updateConfig(msg.config)
      } else if (msg.type === 'tools_list') {
        d.setInfoScroll(0); d.setView({ kind: 'info', title: '工具', lines: msg.tools.map((t) => `${t.name} — ${t.description}`) })
      } else if (msg.type === 'status_state') {
        d.currentCwdRef.current = msg.cwd
        d.setStatusBarData({ provider: msg.provider, model: msg.model, sessionId: msg.sessionId, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens, cwd: msg.cwd })
        // 仅显式请求（/status）时打开 info overlay；启动时的自动请求静默更新。
        if (d.explicitInfoRef.current) {
          d.explicitInfoRef.current = false
          d.setInfoScroll(0); d.setView({ kind: 'info', title: '状态', lines: [
            `session   ${msg.sessionId}`,
            `provider  ${msg.provider}`,
            `model     ${msg.model}`,
            `cwd       ${msg.cwd}`,
            `state     ${msg.state}`,
            `context   ${msg.estimatedTokens} / ${msg.windowTokens}`,
          ] })
        }
      } else if (msg.type === 'context_state') {
        d.setStatusBarData((prev) => ({ ...prev, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens }))
        // 仅显式请求（/context）时打开 info overlay；轮询静默更新 StatusBar。
        if (d.explicitInfoRef.current) {
          d.explicitInfoRef.current = false
          d.setInfoScroll(0); d.setView({ kind: 'info', title: '上下文', lines: [
            `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`,
            `压缩阈值：窗口 80% = ${Math.round(msg.windowTokens * 0.8)}`,
          ] })
        }
      } else if (msg.type === 'system_state') {
        d.setInfoScroll(0); d.setView({ kind: 'info', title: 'system prompt', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.content] })
      } else if (msg.type === 'permissions_list') {
        // /permissions：用 menu overlay 显示当前会话的 allow_always 授权列表。
        if (msg.tools.length === 0) {
          d.setInfoScroll(0)
          d.setView({ kind: 'info', title: '会话权限', lines: ['当前会话没有 allow_always 授权的工具', '（选择权限弹层时选「始终允许」才会出现在这里）'] })
        } else {
          d.openMenu('会话权限（回车撤销授权）', msg.tools.map((t) => ({
            label: `${t}  （回车撤销）`,
            onSelect: () => { d.port.post({ type: 'permission_revoke', tool: t }) },
          })))
        }
      } else if (msg.type === 'log_state') {
        d.setInfoScroll(0); d.setView({ kind: 'info', title: '调试日志', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.tail] })
      }
    })
    // 订阅后主动取一次配置 + 状态，用于顶部品牌头和 CWD 过滤。
    deps.port.post({ type: 'config_request' })
    deps.port.post({ type: 'status_request' })
    return off
  }, [deps.port])
}
