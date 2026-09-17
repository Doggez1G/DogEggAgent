import React, { useCallback } from 'react'
import type { UiPort, UiToAgentMessage } from '@dogegg/bridge'
import { Sidebar, TopBar, ChatView, InputBar, InfoPanel, CommandPalette, ErrorBoundary, SettingsModal, ConfirmModal, HelpModal, FsBrowserModal, PromptModal, PermissionBanner } from '../components'
import { useChatState } from '../features/chat/use-chat-state'
import { useSessions } from '../features/sessions/use-sessions'
import { usePanelData } from '../features/info-panel/use-panel-data'
import { useTurnTracking } from '../features/turn-tracking/use-turn-tracking'
import { useUiChrome } from '../features/chrome/use-ui-chrome'
import { getCommandFeedback, isStateRunning } from '../../shared'
import { COMMAND_TO_MODAL } from '../view-state'
import styles from './app.module.css'

// App：三栏布局——侧栏 + 顶栏 + 聊天 + 输入 + 右侧信息面板。
// 职责边界：本组件只做「特征装配 + 布局」；数据域在各 feature 的 hook 里
// （chat / sessions / info-panel / turn-tracking / chrome），各自独立订阅 port。
interface AppProps {
  port: UiPort
  connectionState?: 'connected' | 'reconnecting' | 'disconnected'
}

export function App({ port, connectionState }: AppProps) {
  const { chat, dispatch } = useChatState(port)
  const { sessions, knownProjects, refresh: refreshSessions, forgetProject } = useSessions(port)
  const panel = usePanelData(port)
  const tracking = useTurnTracking(port)
  const chrome = useUiChrome(connectionState)
  const { modal, setModal, theme, sidebarCollapsed, setSidebarCollapsed, infoCollapsed, setInfoCollapsed, toast, showToast, highlightSection, highlightInfoSection } = chrome

  const isRunning = isStateRunning(chat.status)

  // 安全 POST——捕获网络错误 + HTTP 错误，用户操作（submit/new/resume 等）失败时 toast 提示。
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

  const onCommandNav = useCallback((cmd: string) => {
    const nav = COMMAND_TO_MODAL[cmd]
    if (nav) setModal(nav.modal)
  }, [setModal])

  const onClearHistory = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Clear History', message: 'Clear all messages in the current session? This cannot be undone.', onConfirm: () => { port.post({ type: 'clear_history' }); setModal({ kind: 'none' }) } })
  }, [port, setModal])

  const onQuit = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Quit', message: 'Close the browser tab to quit DogEggAgent WebUI.', onConfirm: () => { setModal({ kind: 'none' }) } })
  }, [setModal])

  // 重命名当前会话：预填现有标题的单行编辑框（/rename 无参、命令面板、信息面板铅笔按钮共用）。
  const openRename = useCallback(() => {
    // 预填侧栏实际显示的「原名」：标题优先，无标题回退预览文本（与列表展示 title || preview 一致），
    // 让用户在原名基础上修改而非从空白开始。
    const cur = sessions.find((s) => s.id === panel.sessionId)
    const current = cur?.title || cur?.preview || ''
    setModal({ kind: 'prompt', title: '重命名会话', value: current, placeholder: '会话名称', onConfirm: (v) => {
      const title = v.trim()
      if (title) port.post({ type: 'rename_session', title })
      setModal({ kind: 'none' })
    } })
  }, [sessions, panel.sessionId, port, setModal])

  const onCommandFeedback = useCallback((cmd: string) => {
    if (cmd === '/cd') setModal({ kind: 'fs-browser', onConfirm: (path) => { port.post({ type: 'set_cwd', path }); setModal({ kind: 'none' }) } })
    else if (cmd === '/rename') openRename()
    else {
      const section = getCommandFeedback(cmd)
      if (section) {
        if (cmd === '/session') setSidebarCollapsed(false)
        highlightInfoSection(section)
      }
    }
  }, [setModal, setSidebarCollapsed, highlightInfoSection, openRename, port])

  const openAddProject = useCallback(() => {
    setModal({ kind: 'fs-browser', onConfirm: (path) => { safePost({ type: 'new_session', cwd: path }, true); setModal({ kind: 'none' }) } })
  }, [setModal, safePost])

  const handleDeleteSession = useCallback((id: string) => {
    setModal({ kind: 'confirm', title: 'Delete Session', message: 'Delete this session permanently? This cannot be undone.', onConfirm: () => { port.post({ type: 'delete_session', id }); setModal({ kind: 'none' }) } })
  }, [port, setModal])

  const handleDeleteProject = useCallback((projectCwd: string) => {
    const projSessions = sessions.filter((s) => (s.cwd || '(unknown)') === projectCwd)
    const count = projSessions.length
    const msg = count > 0
      ? `删除项目 "${projectCwd.split(/[/\\]/).pop()}" 将删除其下 ${count} 个会话的记录。项目目录本身不会被删除，可随时重新添加。确定删除？`
      : `从侧边栏移除项目 "${projectCwd.split(/[/\\]/).pop()}"？项目目录本身不会被删除，可随时重新添加。`
    setModal({ kind: 'confirm', title: count > 0 ? '删除项目' : '移除项目', message: msg, onConfirm: () => {
      projSessions.forEach((s) => port.post({ type: 'delete_session', id: s.id }))
      forgetProject(projectCwd)
      setModal({ kind: 'none' })
    } })
  }, [port, sessions, forgetProject, setModal])

  return (
    <div className={styles.app} data-sidebar-collapsed={sidebarCollapsed} data-info-collapsed={infoCollapsed}>
      <ErrorBoundary area="Sidebar">
        <Sidebar
          cwd={panel.cwd}
          isRunning={isRunning}
          theme={theme}
          collapsed={sidebarCollapsed}
          sessions={sessions}
          knownProjects={knownProjects}
          activeSessionId={panel.sessionId}
          highlightSection={highlightSection}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNewSession={(cwdArg) => safePost({ type: 'new_session', ...(cwdArg ? { cwd: cwdArg } : {}) }, true)}
          onResumeSession={(id) => safePost({ type: 'resume_session', id }, true)}
          onDeleteSession={handleDeleteSession}
          onDeleteProject={handleDeleteProject}
          onAddProject={openAddProject}
          onOpenSettings={() => setModal({ kind: 'settings' })}
          onThemeChange={chrome.setTheme}
        />
      </ErrorBoundary>
      <TopBar
        provider={panel.statusBar.provider}
        model={panel.statusBar.model}
        cwd={panel.cwd}
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
          sessionId={panel.sessionId}
          sessionTitle={sessions.find((s) => s.id === panel.sessionId)?.title}
          onRename={openRename}
          provider={panel.statusBar.provider}
          model={panel.statusBar.model}
          status={chat.status}
          tokens={panel.statusBar.tokens}
          windowTokens={panel.statusBar.windowTokens}
          toolCalls={tracking.toolCalls}
          pendingTool={tracking.pendingTool}
          toolsList={panel.toolsList}
          contextState={panel.contextState}
          systemState={panel.systemState}
          logState={panel.logState}
          filesTouched={tracking.filesTouched}
          permissionsList={panel.permissionsList}
          config={panel.config}
          highlightSection={highlightSection}
          collapsed={infoCollapsed}
          onToggleCollapse={() => setInfoCollapsed(!infoCollapsed)}
          port={port}
        />
      </ErrorBoundary>
      <div className={styles.inputArea}>
        {tracking.pendingPermission && (
          <PermissionBanner
            tool={tracking.pendingPermission.tool}
            input={tracking.pendingPermission.input}
            alwaysScope={tracking.pendingPermission.alwaysScope}
            onDecision={(d) => tracking.resolve(tracking.pendingPermission!.id, tracking.pendingPermission!.tool, d, tracking.pendingPermission!.alwaysScope?.pattern)}
          />
        )}
        <InputBar
          port={port}
          cwd={panel.cwd}
          isRunning={isRunning}
          onCommandNav={onCommandNav}
          onClearHistory={onClearHistory}
          onQuit={onQuit}
          onUserSubmit={(text) => { tracking.recordSubmit(text); dispatch({ type: 'local_user', text }) }}
          onNewSession={() => safePost({ type: 'new_session' }, true)}
          onCompact={() => safePost({ type: 'compact_request' }, true)}
          onAddProject={openAddProject}
          onPostError={(e) => showToast(`Failed to send: ${e.message}`)}
          retryText={tracking.retryText}
          onRetryConsumed={tracking.consumeRetry}
          onCommandFeedback={onCommandFeedback}
        />
      </div>

      {/* 模态层 */}
      {modal.kind === 'settings' && (
        <SettingsModal config={panel.config} port={port} onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'command-palette' && (
        <CommandPalette
          sessions={sessions}
          activeSessionId={panel.sessionId}
          theme={theme}
          onThemeChange={chrome.setTheme}
          onNewSession={(cwdArg) => port.post({ type: 'new_session', ...(cwdArg ? { cwd: cwdArg } : {}) })}
          onResumeSession={(id) => port.post({ type: 'resume_session', id })}
          onOpenSettings={() => setModal({ kind: 'settings' })}
          onClearHistory={onClearHistory}
          onCommandFeedback={onCommandFeedback}
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
      {modal.kind === 'prompt' && (
        <PromptModal title={modal.title} value={modal.value} placeholder={modal.placeholder} onConfirm={modal.onConfirm} onClose={() => setModal({ kind: 'none' })} />
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
