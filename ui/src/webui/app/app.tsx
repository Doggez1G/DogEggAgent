import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { AgentToUiMessage, Config, UiPort, UiToAgentMessage } from '@dogegg/bridge'
import { Sidebar, TopBar, ChatView, InputBar, Settings, InfoPanel, CommandPalette, ErrorBoundary, SettingsModal, ConfirmModal, HelpModal, FsBrowserModal, PermissionBanner } from '../components'
import { Button } from '../components/primitives'
import { reducer, type ChatState, getToolPermission, getCommandFeedback, isStateRunning } from '../../shared'
import type { ThemeName, Modal, SessionItem, FileTouched } from './view-state'
import { COMMAND_TO_MODAL } from './view-state'
import styles from './app.module.css'

// App：三栏布局——侧栏 + 顶栏 + 聊天 + 输入 + 右侧信息面板。
// 设置/命令面板/权限等通过 modal 弹窗呈现。
interface AppProps {
  port: UiPort
  connectionState?: 'connected' | 'reconnecting' | 'disconnected'
}

const initialState: ChatState = { blocks: [], status: 'idle', partial: null }

export function App({ port, connectionState }: AppProps) {
  const [chat, dispatch] = useReducer(reducer, initialState)
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [theme, setTheme] = useState<ThemeName>('midnight')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [infoCollapsed, setInfoCollapsed] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [cwd, setCwd] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [statusBar, setStatusBar] = useState<{ provider?: string; model?: string; tokens?: number; windowTokens?: number }>({})
  const [sessions, setSessions] = useState<SessionItem[]>([])
  // 已知项目 cwd 集合——即使所有会话被删除，项目仍保留显示，直到用户显式删除。
  const [knownProjects, setKnownProjects] = useState<Set<string>>(new Set())
  useEffect(() => {
    setKnownProjects((prev) => {
      const next = new Set(prev)
      for (const s of sessions) { if (s.cwd) next.add(s.cwd) }
      return next
    })
  }, [sessions])
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  const [contextState, setContextState] = useState<{ estimatedTokens: number; windowTokens: number; percent: number } | null>(null)
  const [systemState, setSystemState] = useState<{ path: string; content: string } | null>(null)
  const [logState, setLogState] = useState<{ path: string; tail: string } | null>(null)
  const [permissionsList, setPermissionsList] = useState<string[]>([])
  const [toolCalls, setToolCalls] = useState<{ id: string; name: string; status: 'running' | 'done' | 'error' | 'rejected'; output?: string; decision?: 'allow_once' | 'allow_always' | 'reject'; configPerm: string; seq: number }[]>([])
  const [filesTouched, setFilesTouched] = useState<FileTouched[]>([])
  const [pendingPermission, setPendingPermission] = useState<{ id: string; tool: string; input: unknown } | null>(null)
  const [highlightSection, setHighlightSection] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // 错误自动重填——出错时把上次提交的文本回填到输入框，方便重试（与 TUI 行为一致）。
  const [retryText, setRetryText] = useState<string | null>(null)
  const lastSubmitText = useRef<string>('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolSeqRef = useRef(0)
  // 追踪最新 config——onMessage 闭包不能直接读 config state（不在 effect deps 中）。
  const configRef = useRef<Config | null>(null)
  useEffect(() => { configRef.current = config }, [config])
  // 记录 permission_decision 的 toolName→decision 映射，供 tool_start 时关联决策标签。
  // permission_request.id 与 tool_start.id 不同（后端分别生成），无法按 id 匹配，改用 toolName。
  const permissionDecisions = useRef<Map<string, 'allow_once' | 'allow_always' | 'reject'>>(new Map())
  // 连接状态——首次从 connected 变为非 connected 时 toast 提醒。
  const prevConnState = useRef<'connected' | 'reconnecting' | 'disconnected'>('reconnecting')

  // 显示 toast 提示——3 秒后自动消失。
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }, [])

  // 高亮右侧面板某个 section——展开面板 + 设置高亮 key，3 秒后消失。
  // 独立 timer，不与 toast 共用（修复之前共享 toastTimer 导致 toast 不消失的 bug）。
  const highlightInfoSection = useCallback((section: string) => {
    setInfoCollapsed(false)
    setHighlightSection(section)
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightSection(null), 3000)
  }, [])

  // 连接状态变化——首次断连时 toast 提醒，重连后也提示。
  useEffect(() => {
    const prev = prevConnState.current
    if (prev !== 'connected' && connectionState === 'connected') {
      if (prev === 'disconnected' || prev === 'reconnecting') showToast('Reconnected')
    } else if (prev === 'connected' && connectionState !== 'connected') {
      showToast(connectionState === 'disconnected' ? 'Connection lost' : 'Reconnecting...')
    }
    prevConnState.current = connectionState ?? 'reconnecting'
  }, [connectionState, showToast])

  const modalRef = useRef(modal)
  useEffect(() => { modalRef.current = modal }, [modal])

  // 安全 POST——捕获网络错误 + HTTP 错误，用户操作（submit/new/resume 等）失败时 toast 提示。
  // 后台刷新请求（context_request/log_request 等）失败时静默，不打扰用户。
  const safePost = useCallback((msg: UiToAgentMessage, isUserAction = false) => {
    try {
      const result = port.post(msg)
      if (result instanceof Promise) {
        result.catch((e: unknown) => {
          if (isUserAction) showToast(`Failed: ${e instanceof Error ? e.message : 'network error'}`)
        })
      }
    } catch (e) {
      if (isUserAction) showToast(`Failed: ${e instanceof Error ? e.message : 'error'}`)
    }
  }, [port, showToast])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const refreshSessions = useCallback(() => {
    port.post({ type: 'list_sessions' })
  }, [port])

  const onCommandNav = useCallback((cmd: string) => {
    const nav = COMMAND_TO_MODAL[cmd]
    if (nav) setModal(nav.modal)
  }, [])

  const onClearHistory = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Clear History', message: 'Clear all messages in the current session? This cannot be undone.', onConfirm: () => { port.post({ type: 'clear_history' }); setModal({ kind: 'none' }) } })
  }, [port])

  const onQuit = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Quit', message: 'Close the browser tab to quit DogEggAgent WebUI.', onConfirm: () => { setModal({ kind: 'none' }) } })
  }, [])

  // Cmd+K 命令面板。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setModal((prev) => prev.kind === 'command-palette' ? { kind: 'none' } : { kind: 'command-palette' })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const off = port.onMessage((msg: AgentToUiMessage) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setPendingPermission({ id: msg.id, tool: msg.tool, input: msg.input })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && pendingPermission) {
        setPendingPermission(null)
      } else if (msg.type === 'config_state' || msg.type === 'config_updated') {
        setConfig(msg.config)
      } else if (msg.type === 'status_state') {
        setCwd(msg.cwd)
        setSessionId(msg.sessionId)
        setStatusBar({ provider: msg.provider, model: msg.model, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens })
      } else if (msg.type === 'session_list') {
        setSessions(msg.sessions)
      } else if (msg.type === 'session_ready') {
        setSessionId(msg.id)
        setFilesTouched([])
        toolSeqRef.current = 0
        // 清除旧会话的右侧面板数据——新会话的数据需要重新请求。
        setContextState(null)
        setSystemState(null)
        setLogState(null)
        setToolCalls([])
        setPermissionsList([])
        // 请求新会话的实时状态 + 右侧面板数据（不依赖 InfoPanel 的 effect timing）。
        port.post({ type: 'status_request' })
        port.post({ type: 'context_request' })
        port.post({ type: 'system_request' })
        port.post({ type: 'log_request' })
        port.post({ type: 'tools_request' })
        port.post({ type: 'permissions_request' })
        refreshSessions()
      } else if (msg.type === 'session_deleted') {
        setSessions((prev) => prev.filter((s) => s.id !== msg.id))
      } else if (msg.type === 'tools_list') {
        setToolsList(msg.tools)
      } else if (msg.type === 'context_state') {
        setContextState({ estimatedTokens: msg.estimatedTokens, windowTokens: msg.windowTokens, percent: msg.percent })
      } else if (msg.type === 'system_state') {
        setSystemState({ path: msg.path, content: msg.content })
      } else if (msg.type === 'log_state') {
        setLogState({ path: msg.path, tail: msg.tail })
      } else if (msg.type === 'permissions_list') {
        setPermissionsList(msg.tools)
      } else if (msg.type === 'tool_start') {
        const seq = ++toolSeqRef.current
        // 按 toolName 查找 decision——permission_request.id 与 tool_start.id 不同。
        const decision = permissionDecisions.current.get(msg.name)
        // 记录执行时的配置权限快照——不随后续设置变化。
        const configPerm = getToolPermission(msg.name, configRef.current)
        setToolCalls((prev) => [...prev, { id: msg.id, name: msg.name, status: 'running', seq, decision, configPerm }])
        // 用完后清除 decision（避免下一个同名工具继承上次决策）。
        if (decision) permissionDecisions.current.delete(msg.name)
        // allow_always 决策后刷新 Session Permissions 列表——tool_start 到达时 permission.apply 已执行。
        if (decision === 'allow_always') port.post({ type: 'permissions_request' })
        // Files Touched：从 tool_start input 提取文件路径。
        if ((msg.name === 'edit_file' || msg.name === 'write_file') && msg.input) {
          const inp = msg.input as Record<string, unknown>
          const path = String(inp.path ?? '')
          if (path) {
            setFilesTouched((prev) => [...prev, {
              path,
              action: msg.name === 'edit_file' ? 'edit' : 'write',
              toolName: msg.name,
              time: Date.now(),
            }])
          }
        }
      } else if (msg.type === 'tool_end') {
        // 检测是否是被拒绝的工具——error === 'denied' 表示拒绝（无前置 tool_start）。
        const isRejected = msg.error === 'denied'
        setToolCalls((prev) => {
          const idx = prev.findIndex((tc) => tc.id === msg.id)
          if (idx >= 0) {
            // 正常路径：有 tool_start，更新状态。
            // 保留 tool_start 时记录的 decision——仅在拒绝时覆盖为 'reject'。
            const existing = prev[idx]!
            const updated = [...prev]
            updated[idx] = {
              ...existing,
              status: isRejected ? 'rejected' : (msg.error ? 'error' : 'done'),
              output: msg.output,
              decision: isRejected ? 'reject' : existing.decision,
            }
            return updated
          }
          // 孤儿 tool_end（被拒绝/未知工具）——创建新条目。
          const seq = ++toolSeqRef.current
          const configPerm = getToolPermission(msg.name, configRef.current)
          return [...prev, { id: msg.id, name: msg.name, status: 'rejected', output: msg.output, decision: 'reject', configPerm, seq }]
        })
      } else if (msg.type === 'history_cleared') {
        setFilesTouched([])
        setToolCalls([])
        port.post({ type: 'context_request' })
      } else if (msg.type === 'compaction') {
        port.post({ type: 'context_request' })
      } else if (msg.type === 'notice') {
        // notice 由 reducer 处理为对话面板中的 notice 块，不需要 toast。
      } else if (msg.type === 'finished' || msg.type === 'error') {
        // 对话结束后刷新会话列表 + context + log 状态。
        refreshSessions()
        port.post({ type: 'context_request' })
        port.post({ type: 'log_request' })
        // 出错时自动回填上次输入到输入框，方便重试（与 TUI 行为一致）。
        if (msg.type === 'error' && lastSubmitText.current) {
          setRetryText(lastSubmitText.current)
        }
      }
    })
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
    refreshSessions()
    return off
  }, [port, refreshSessions])

  const isRunning = useMemo(() => isStateRunning(chat.status), [chat.status])

  const handleDeleteSession = useCallback((id: string) => {
    setModal({ kind: 'confirm', title: 'Delete Session', message: 'Delete this session permanently? This cannot be undone.', onConfirm: () => { port.post({ type: 'delete_session', id }); setModal({ kind: 'none' }) } })
  }, [port])

  const handleDeleteProject = useCallback((projectCwd: string) => {
    const projSessions = sessions.filter((s) => (s.cwd || '(unknown)') === projectCwd)
    const count = projSessions.length
    const msg = count > 0
      ? `删除项目 "${projectCwd.split(/[/\\]/).pop()}" 将删除其下 ${count} 个会话的记录。项目目录本身不会被删除，可随时重新添加。确定删除？`
      : `从侧边栏移除项目 "${projectCwd.split(/[/\\]/).pop()}"？项目目录本身不会被删除，可随时重新添加。`
    setModal({ kind: 'confirm', title: count > 0 ? '删除项目' : '移除项目', message: msg, onConfirm: () => {
      projSessions.forEach((s) => port.post({ type: 'delete_session', id: s.id }))
      setKnownProjects((prev) => { const next = new Set(prev); next.delete(projectCwd); return next })
      setModal({ kind: 'none' })
    } })
  }, [port, sessions])

  return (
    <div className={styles.app} data-sidebar-collapsed={sidebarCollapsed} data-info-collapsed={infoCollapsed}>
      <ErrorBoundary area="Sidebar">
        <Sidebar
          cwd={cwd}
          isRunning={isRunning}
          theme={theme}
          collapsed={sidebarCollapsed}
          sessions={sessions}
          knownProjects={knownProjects}
          activeSessionId={sessionId}
          highlightSection={highlightSection}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNewSession={(cwdArg) => safePost({ type: 'new_session', ...(cwdArg ? { cwd: cwdArg } : {}) }, true)}
          onResumeSession={(id) => safePost({ type: 'resume_session', id }, true)}
          onDeleteSession={handleDeleteSession}
          onDeleteProject={handleDeleteProject}
          onAddProject={() => setModal({ kind: 'fs-browser', onConfirm: (path) => { safePost({ type: 'new_session', cwd: path }, true); setModal({ kind: 'none' }) } })}
          onOpenSettings={() => setModal({ kind: 'settings' })}
          onThemeChange={setTheme}
        />
      </ErrorBoundary>
      <TopBar
        provider={statusBar.provider}
        model={statusBar.model}
        cwd={cwd}
        isRunning={isRunning}
        status={chat.status}
        connectionState={connectionState}
        onOpenCommandPalette={() => setModal({ kind: 'command-palette' })}
      />
      <div className={styles.mainArea}>
        <ErrorBoundary area="Chat">
          <ChatView chat={chat} isRunning={isRunning} />
        </ErrorBoundary>
      </div>
      <ErrorBoundary area="Info Panel">
        <InfoPanel
          sessionId={sessionId}
          provider={statusBar.provider}
          model={statusBar.model}
          status={chat.status}
          tokens={statusBar.tokens}
          windowTokens={statusBar.windowTokens}
          toolCalls={toolCalls}
          toolsList={toolsList}
          contextState={contextState}
          systemState={systemState}
          logState={logState}
          filesTouched={filesTouched}
          permissionsList={permissionsList}
          config={config}
          highlightSection={highlightSection}
          collapsed={infoCollapsed}
          onToggleCollapse={() => setInfoCollapsed(!infoCollapsed)}
          port={port}
        />
      </ErrorBoundary>
      <div className={styles.inputArea}>
        {pendingPermission && (
          <PermissionBanner
            tool={pendingPermission.tool}
            input={pendingPermission.input}
            onDecision={(d) => { permissionDecisions.current.set(pendingPermission.tool, d); port.post({ type: 'permission_decision', id: pendingPermission.id, decision: d }); setPendingPermission(null) }}
          />
        )}
        <InputBar
          port={port}
          isRunning={isRunning}
          onCommandNav={onCommandNav}
          onClearHistory={onClearHistory}
          onQuit={onQuit}
          onUserSubmit={(text) => { lastSubmitText.current = text; dispatch({ type: 'local_user', text }) }}
          onNewSession={() => safePost({ type: 'new_session' }, true)}
          onCompact={() => safePost({ type: 'compact_request' }, true)}
          onAddProject={() => setModal({ kind: 'fs-browser', onConfirm: (path) => { safePost({ type: 'new_session', cwd: path }, true); setModal({ kind: 'none' }) } })}
          onPostError={(e) => showToast(`Failed to send: ${e.message}`)}
          retryText={retryText}
          onRetryConsumed={() => setRetryText(null)}
          onCommandFeedback={(cmd) => {
            if (cmd === '/cd') setModal({ kind: 'fs-browser', onConfirm: (path) => { port.post({ type: 'set_cwd', path }); setModal({ kind: 'none' }) } })
            else {
              const section = getCommandFeedback(cmd)
              if (section) {
                if (cmd === '/session') setSidebarCollapsed(false)
                highlightInfoSection(section)
              }
            }
          }}
        />
      </div>

      {/* 模态层 */}
      {modal.kind === 'settings' && (
        <SettingsModal config={config} port={port} onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'command-palette' && (
        <CommandPalette
          sessions={sessions}
          activeSessionId={sessionId}
          theme={theme}
          onThemeChange={setTheme}
          onNewSession={(cwdArg) => port.post({ type: 'new_session', ...(cwdArg ? { cwd: cwdArg } : {}) })}
          onResumeSession={(id) => port.post({ type: 'resume_session', id })}
          onOpenSettings={() => setModal({ kind: 'settings' })}
          onClearHistory={onClearHistory}
          onCommandFeedback={(cmd) => {
            const section = getCommandFeedback(cmd)
            if (section) {
              if (cmd === '/session') setSidebarCollapsed(false)
              highlightInfoSection(section)
            }
          }}
          onClose={() => setModal({ kind: 'none' })}
          port={port}
        />
      )}
      {modal.kind === 'confirm' && (
        <ConfirmModal title={modal.title} message={modal.message} onConfirm={modal.onConfirm} onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'help' && (
        <HelpModal onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'fs-browser' && (
        <FsBrowserModal onConfirm={modal.onConfirm} onClose={() => setModal({ kind: 'none' })} />
      )}

      {/* Toast 提示 */}
      {toast && (
        <div className={styles.toast + ' block-enter'}>{toast}</div>
      )}
    </div>
  )
}
