import { useEffect, useRef } from 'react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import type { View } from '../view-state'

export interface StatusBarData {
  provider?: string
  model?: string
  sessionId?: string
  /** 会话名（/rename 或自动标题；经 session_list 同步到状态栏）。 */
  title?: string
  tokens?: number
  windowTokens?: number
  usage?: { promptTokens: number; completionTokens: number; turns: number }
  cwd?: string
}

export interface AgentEventsDeps {
  port: UiPort
  viewRef: { current: View }
  currentCwdRef: { current: string }
  /** 显式信息请求标记：/context /status 等命令置 true，回响应时打开 info overlay；轮询静默。 */
  explicitInfoRef: { current: boolean }
  /** /tools 独立 intent：工具面板只由显式 /tools 打开——与后台播种的 tools_list 互不干扰。 */
  toolsIntentRef: { current: boolean }
  /** /model vs /config 的 intent：后端回 config_state 时据此打开对应选择器。 */
  configIntentRef: { current: 'model' | 'config' | null }
  setView(view: View): void
  updateConfig(c: Config): void
  openMenu(title: string, items: { label: string; onSelect: () => void }[]): void
  openModelPicker(c: Config): void
  openConfigTree(c: Config): void
  setStatusBarData(updater: StatusBarData | ((d: StatusBarData) => StatusBarData)): void
  setToolsList(tools: { name: string; description: string }[]): void
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
  // 当前会话 id 镜像——session_list 回来时据此找到「当前会话」的标题同步进状态栏。
  const sessionIdRef = useRef('')

  useEffect(() => {
    const off = deps.port.onMessage((msg: AgentToUiMessage) => {
      const d = ref.current
      // 会话切换/清空：清屏 + Static 重挂载（Static 已输出的内容无法撤回）。
      if (msg.type === 'session_ready' || msg.type === 'history_cleared') {
        d.clearScreenRemount()
        d.onSessionCleared()
      }
      if (msg.type === 'session_ready') {
        // 新建/切换会话：标题清零并重拉列表回填——resume 恢复的标题由此回来，全新会话保持无名。
        sessionIdRef.current = msg.id
        d.setStatusBarData((prev) => ({ ...prev, title: undefined }))
        d.port.post({ type: 'list_sessions' })
      }
      // 错误恢复：error 时自动预填上次提交的文本到输入框，用户可直接改或重新提交。
      if (msg.type === 'error') d.onErrorRetry()
      if (msg.type === 'permission_request') {
        d.setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, alwaysScope: msg.alwaysScope, cursor: 0 })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && d.viewRef.current.kind === 'permission') {
        // 权限等待期间状态离开 waiting_permission（如 cancel）→ 关闭 permission overlay。
        d.setView({ kind: 'none' })
      } else if (msg.type === 'session_list') {
        // 当前会话名同步进状态栏——启动播种、/session 响应、重命名、自动标题、切换会话后的刷新都汇聚到此。
        const cur = msg.sessions.find((s) => s.id === sessionIdRef.current)
        d.setStatusBarData((prev) => ({ ...prev, title: cur?.title }))
        // 会话列表更新只刷新「已打开的」选择器（/session 请求响应、删除后刷新），并保留搜索词与光标；
        // 重命名/自动标题等后端主动推送不带弹层语义——选择器未开时忽略（否则每次改名都蹦出列表）。
        if (d.viewRef.current.kind !== 'sessionPicker') return
        // 按 cwd 过滤：只显示当前工作目录下的会话（Claude 式——每个目录独立）。
        // 路径归一化：统一为小写 + 正斜杠，兼容 Windows 反斜杠 + 大小写不敏感。
        const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const cwd = normalize(d.currentCwdRef.current)
        const filtered = msg.sessions.filter((s) => normalize(s.cwd ?? '') === cwd)
        d.setView({ ...d.viewRef.current, sessions: filtered.map((s) => ({ id: s.id, preview: s.preview || '（空会话）', title: s.title, updatedAt: s.updatedAt })) })
      } else if (msg.type === 'session_deleted') {
        // 会话删除后刷新列表——重新请求 session_list（会触发 sessionPicker 重建）。
        d.port.post({ type: 'list_sessions' })
      } else if (msg.type === 'config_state') {
        d.updateConfig(msg.config)
        if (d.configIntentRef.current === 'model') { d.openModelPicker(msg.config); d.configIntentRef.current = null }
        else if (d.configIntentRef.current === 'config') { d.openConfigTree(msg.config); d.configIntentRef.current = null }
      } else if (msg.type === 'config_updated') {
        d.updateConfig(msg.config)
        // 配置变更可能增删 MCP 等运行时工具——重新播种工具清单镜像（静默，不开面板）。
        d.port.post({ type: 'tools_request' })
      } else if (msg.type === 'tools_list') {
        // 运行时清单镜像：一律更新（/config 工具选择器的候选来源，MCP 运行期注册的工具自动出现）；
        // info 面板仅在显式请求（/tools，独立 intent）时打开——挂载/配置变更的播种是静默的。
        d.setToolsList(msg.tools)
        if (d.toolsIntentRef.current) {
          d.toolsIntentRef.current = false
          d.setInfoScroll(0); d.setView({ kind: 'info', title: '工具', lines: msg.tools.map((t) => `${t.name} — ${t.description}`) })
        }
      } else if (msg.type === 'status_state') {
        sessionIdRef.current = msg.sessionId
        d.currentCwdRef.current = msg.cwd
        d.setStatusBarData({ provider: msg.provider, model: msg.model, sessionId: msg.sessionId, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens, usage: msg.usage, cwd: msg.cwd })
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
        d.setStatusBarData((prev) => ({ ...prev, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens, usage: msg.sessionUsage }))
        // 仅显式请求（/context）时打开 info overlay；轮询静默更新 StatusBar。
        if (d.explicitInfoRef.current) {
          d.explicitInfoRef.current = false
          const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
          const lines: string[] = [
            // 「当前 context」= 下一轮请求的粗估（system + 消息 + 工具 schema）；与会话累计口径不同（见下）。
            `当前 context（估算）　${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`,
          ]
          if (msg.breakdown) {
            const b = msg.breakdown
            lines.push(`　分段　　system ${fmt(b.system)} ｜ 用户 ${fmt(b.user)} ｜ 助手 ${fmt(b.assistant)} ｜ 工具输出 ${fmt(b.tool)} ｜ schema ${fmt(b.tools)}`)
          }
          if (msg.lastTurn) {
            lines.push(`上一轮 API 实际　prompt ${msg.lastTurn.promptTokens} + completion ${msg.lastTurn.completionTokens}（并排对照估算，可见校准误差）`)
          }
          if (msg.sessionUsage && msg.sessionUsage.turns > 0) {
            const u = msg.sessionUsage
            // 口径说明：累计含「已被压缩掉的历史轮次」——因此会大于当前 context 估算，是预期行为。
            lines.push(`会话累计 API 实际　prompt ${u.promptTokens} + completion ${u.completionTokens}（${u.turns} 轮，含已被压缩的历史）`)
          }
          lines.push(`已压缩　${msg.compactions} 次`)
          lines.push(`压缩阈值　窗口 80% = ${Math.round(msg.windowTokens * 0.8)}`)
          d.setInfoScroll(0); d.setView({ kind: 'info', title: '上下文', lines })
        }
      } else if (msg.type === 'system_state') {
        d.setInfoScroll(0); d.setView({ kind: 'info', title: 'system prompt', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.content] })
      } else if (msg.type === 'permissions_list') {
        // /permissions：按工具分组展示会话内提升——有模式者下钻逐条撤（撤光即整条移除），整工具者就地撤；
        // 每次撤销后 agent 重推 permissions_list，菜单刷新回顶层。
        if (msg.permissions.length === 0) {
          d.setInfoScroll(0)
          d.setView({ kind: 'info', title: '会话权限', lines: ['当前会话没有任何权限提升', '（权限弹层选「始终允许」或「对此范围不再询问」会出现在这里）'] })
        } else {
          d.openMenu('会话权限（回车撤销）', msg.permissions.map(({ tool, patterns }) => ({
            label: `${tool} — ${patterns.length === 0 ? '整工具' : patterns.join('  ')}`,
            onSelect: () => {
              if (patterns.length === 0) { d.port.post({ type: 'permission_revoke', tool }); return }
              d.openMenu(`会话权限 / ${tool}`, [
                ...patterns.map((p) => ({
                  label: `${p}（回车撤销）`,
                  onSelect: () => { d.port.post({ type: 'permission_revoke', tool, pattern: p }) },
                })),
                { label: '撤销该工具全部提升', onSelect: () => { d.port.post({ type: 'permission_revoke', tool }) } },
              ])
            },
          })))
        }
      } else if (msg.type === 'log_state') {
        d.setInfoScroll(0); d.setView({ kind: 'info', title: '调试日志', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.tail] })
      }
    })
    // 订阅后主动取一次配置 + 状态 + 工具清单 + 会话列表：
    // 品牌头/CWD 过滤/权限工具选择器/状态栏会话名都依赖它们。
    deps.port.post({ type: 'config_request' })
    deps.port.post({ type: 'status_request' })
    deps.port.post({ type: 'tools_request' })
    deps.port.post({ type: 'list_sessions' })
    return off
  }, [deps.port])
}
