import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { marked } from 'marked'
import { ChevronRight, FolderClosed, FolderUp, ArrowLeft, X } from 'lucide-react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import { Sidebar, TopBar, ChatView, InputBar, StatusBar, Settings, InfoPanel } from '../components'
import { reducer, type ChatState } from '../../shared/reducer'
import type { Block } from '../../shared/block'
import type { SettingsTab, ThemeName, Modal, SessionItem } from './view-state'
import { COMMAND_TO_MODAL } from './view-state'
import styles from './app.module.css'

// App：单一布局——侧栏（项目/会话树）+ 顶栏 + 聊天 + 输入 + 右侧信息面板。
// 设置通过 modal 弹窗呈现，不再切换 panel。
interface AppProps {
  port: UiPort
}

const initialState: ChatState = { blocks: [], status: 'idle', partial: null }
marked.setOptions({ breaks: true, gfm: true })

export function App({ port }: AppProps) {
  const [chat, dispatch] = useReducer(reducer, initialState)
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [theme, setTheme] = useState<ThemeName>('catppuccin')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [infoCollapsed, setInfoCollapsed] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [cwd, setCwd] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [statusBar, setStatusBar] = useState<{ provider?: string; model?: string; tokens?: number; windowTokens?: number }>({})
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  const [contextState, setContextState] = useState<{ estimatedTokens: number; windowTokens: number; percent: number } | null>(null)
  const [systemState, setSystemState] = useState<{ path: string; content: string } | null>(null)
  const [logState, setLogState] = useState<{ path: string; tail: string } | null>(null)
  const [permissionsList, setPermissionsList] = useState<string[]>([])
  // 工具调用追踪（右侧信息面板显示）。
  const [toolCalls, setToolCalls] = useState<{ id: string; name: string; status: 'running' | 'done' | 'error'; output?: string }[]>([])

  const modalRef = useRef(modal)
  useEffect(() => { modalRef.current = modal }, [modal])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // 请求会话列表（侧栏需要）。
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

  useEffect(() => {
    const off = port.onMessage((msg: AgentToUiMessage) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setModal({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && modalRef.current.kind === 'permission') {
        setModal({ kind: 'none' })
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
        setToolCalls((prev) => [...prev, { id: msg.id, name: msg.name, status: 'running' }])
      } else if (msg.type === 'tool_end') {
        setToolCalls((prev) => prev.map((tc) =>
          tc.id === msg.id ? { ...tc, status: msg.error ? 'error' : 'done', output: msg.output } : tc
        ))
      }
    })
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
    refreshSessions()
    return off
  }, [port, refreshSessions])

  const isRunning = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'

  const renderBlocks = chat.blocks.map((b: Block) => ({
    ...b,
    html: b.kind === 'assistant' || b.kind === 'thinking' ? marked.parse(b.text) : b.text,
    fullHtml: b.full !== undefined ? (b.kind === 'assistant' || b.kind === 'thinking' ? marked.parse(b.full) : b.full) : undefined,
  }))
  const partialHtml = chat.partial ? marked.parse(chat.partial.text) : null

  // 删除会话确认。
  const handleDeleteSession = useCallback((id: string) => {
    setModal({ kind: 'confirm', title: 'Delete Session', message: 'Delete this session permanently? This cannot be undone.', onConfirm: () => { port.post({ type: 'delete_session', id }); setModal({ kind: 'none' }) } })
  }, [port])

  // 删除项目确认（删除该 cwd 下所有会话）。
  const handleDeleteProject = useCallback((projectCwd: string) => {
    const count = sessions.filter((s) => (s.cwd || '(unknown)') === projectCwd).length
    setModal({ kind: 'confirm', title: 'Delete Project', message: `Delete project "${projectCwd.split(/[/\\]/).pop()}" and its ${count} session(s)? This cannot be undone.`, onConfirm: () => {
      sessions.filter((s) => (s.cwd || '(unknown)') === projectCwd).forEach((s) => port.post({ type: 'delete_session', id: s.id }))
      setModal({ kind: 'none' })
    } })
  }, [port, sessions])

  return (
    <div className={styles.app} data-sidebar-collapsed={sidebarCollapsed} data-info-collapsed={infoCollapsed}>
      <Sidebar
        cwd={cwd}
        isRunning={isRunning}
        theme={theme}
        collapsed={sidebarCollapsed}
        sessions={sessions}
        activeSessionId={sessionId}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onNewSession={(cwdArg) => port.post({ type: 'new_session', ...(cwdArg ? { cwd: cwdArg } : {}) })}
        onResumeSession={(id) => port.post({ type: 'resume_session', id })}
        onDeleteSession={handleDeleteSession}
        onDeleteProject={handleDeleteProject}
        onAddProject={() => setModal({ kind: 'fs-browser', onConfirm: (path) => { port.post({ type: 'new_session', cwd: path }); setModal({ kind: 'none' }) } })}
        onOpenSettings={() => setModal({ kind: 'settings', tab: 'general' })}
        onThemeChange={setTheme}
      />
      <TopBar provider={statusBar.provider} model={statusBar.model} cwd={cwd} isRunning={isRunning} />
      <div className={styles.mainArea}>
        <ChatView chat={{ ...chat, blocks: renderBlocks as unknown as Block[], partial: chat.partial ? { ...chat.partial, html: partialHtml } : null } as unknown as ChatState} isRunning={isRunning} />
      </div>
      <InfoPanel
        provider={statusBar.provider}
        model={statusBar.model}
        status={chat.status}
        tokens={statusBar.tokens}
        windowTokens={statusBar.windowTokens}
        toolCalls={toolCalls}
        collapsed={infoCollapsed}
        onToggleCollapse={() => setInfoCollapsed(!infoCollapsed)}
      />
      <div className={styles.inputArea}>
        <StatusBar status={chat.status} tokens={statusBar.tokens} windowTokens={statusBar.windowTokens} />
        <InputBar port={port} isRunning={isRunning} onCommandNav={onCommandNav} onClearHistory={onClearHistory} onQuit={onQuit} />
      </div>

      {/* 模态层 */}
      {modal.kind === 'settings' && (
        <SettingsModal
          tab={modal.tab}
          config={config}
          port={port}
          toolsList={toolsList}
          contextState={contextState}
          systemState={systemState}
          logState={logState}
          permissionsList={permissionsList}
          onTabChange={(tab) => setModal({ kind: 'settings', tab })}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
      {modal.kind === 'permission' && (
        <PermissionModal id={modal.id} tool={modal.tool} input={modal.input}
          onDecision={(d) => { port.post({ type: 'permission_decision', id: modal.id, decision: d }); setModal({ kind: 'none' }) }}
          onClose={() => { port.post({ type: 'permission_decision', id: modal.id, decision: 'reject' }); setModal({ kind: 'none' }) }} />
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
    </div>
  )
}

// ── 设置 Modal（scrim + 大弹窗，复用 Settings 组件逻辑）──
function SettingsModal(props: {
  tab: SettingsTab
  config: Config | null
  port: UiPort
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  permissionsList: string[]
  onTabChange: (tab: SettingsTab) => void
  onClose: () => void
}) {
  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.settingsModal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fsModalHeader}>
          <h2 className={styles.modalTitle}>Settings</h2>
          <button className={styles.modalClose} onClick={props.onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
        </div>
        <div className={styles.settingsModalBody}>
          <Settings
            tab={props.tab}
            config={props.config}
            port={props.port}
            toolsList={props.toolsList}
            contextState={props.contextState}
            systemState={props.systemState}
            logState={props.logState}
            permissionsList={props.permissionsList}
            onTabChange={props.onTabChange}
            onBack={props.onClose}
          />
        </div>
      </div>
    </div>
  )
}

// ── 其他模态组件 ──

function PermissionModal(props: { id: string; tool: string; input: unknown; onDecision: (d: 'allow_once' | 'allow_always' | 'reject') => void; onClose: () => void }) {
  const inp = props.input as Record<string, unknown> | null
  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fsModalHeader}>
          <h2 className={styles.modalTitle}>Permission: {props.tool}</h2>
          <button className={styles.modalClose} onClick={props.onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
        </div>
        {props.tool === 'edit_file' && inp && (
          <pre className={styles.diffPreview}>- {String(inp.old_string ?? '').slice(0, 200)}{'\n'}+ {String(inp.new_string ?? '').slice(0, 200)}</pre>
        )}
        {props.tool === 'write_file' && inp && (
          <pre className={styles.diffPreview}>+ {String(inp.content ?? '').slice(0, 200)}</pre>
        )}
        {props.tool === 'shell' && inp && (
          <pre className={styles.diffPreview}>{String(inp.command ?? '')}</pre>
        )}
        <div className={styles.modalActions}>
          <button className={styles.btnPrimary} onClick={() => props.onDecision('allow_once')}>Allow Once</button>
          <button className={styles.btnSecondary} onClick={() => props.onDecision('allow_always')}>Allow Always</button>
          <button className={styles.btnDanger} onClick={() => props.onDecision('reject')}>Reject</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal(props: { title: string; message: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fsModalHeader}>
          <h2 className={styles.modalTitle}>{props.title}</h2>
          <button className={styles.modalClose} onClick={props.onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
        </div>
        <p className={styles.modalMessage}>{props.message}</p>
        <div className={styles.modalActions}>
          <button className={styles.btnPrimary} onClick={props.onConfirm}>Confirm</button>
          <button className={styles.btnSecondary} onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function HelpModal(props: { onClose: () => void }) {
  const commands = [
    ['/new', 'New session'], ['/session', 'List sessions'], ['/config', 'Settings'],
    ['/model', 'Switch model'], ['/clear', 'Clear history'], ['/compact', 'Compact context'],
    ['/cd', 'Change directory'], ['/context', 'Context usage'], ['/tools', 'List tools'],
    ['/system', 'System prompt'], ['/status', 'Status'], ['/log', 'Debug log'],
    ['/permissions', 'Session permissions'], ['/help', 'This help'],
  ]
  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fsModalHeader}>
          <h2 className={styles.modalTitle}>Commands</h2>
          <button className={styles.modalClose} onClick={props.onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
        </div>
        <div className={styles.helpGrid}>
          {commands.map(([cmd, desc]) => (
            <React.Fragment key={cmd}>
              <code className={styles.helpCmd}>{cmd}</code>
              <span className={styles.helpDesc}>{desc}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

function FsBrowserModal(props: { onConfirm: (path: string) => void; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/fs').then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }, [])

  const browse = (path: string) => {
    setHistory((h) => [...h, current])
    fetch(`/api/fs?path=${encodeURIComponent(path)}`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }

  const goBack = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]!
    setHistory((h) => h.slice(0, -1))
    fetch(`/api/fs?path=${encodeURIComponent(prev)}`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }

  const breadcrumbs = current ? current.split(/[/\\]/).filter(Boolean) : []

  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.fsModalHeader}>
          <h2 className={styles.modalTitle}>Select Working Directory</h2>
          <button className={styles.modalClose} onClick={props.onClose} aria-label="Close"><X size={16} strokeWidth={2} /></button>
        </div>
        <div className={styles.fsBreadcrumb}>
          {history.length > 0 && (<button className={styles.fsBackBtn} onClick={goBack} aria-label="Go back"><ArrowLeft size={14} strokeWidth={1.5} /></button>)}
          {parent && (<button className={styles.fsCrumbUp} onClick={() => browse(parent)} title="Go up"><FolderUp size={14} strokeWidth={1.5} /></button>)}
          {breadcrumbs.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={10} strokeWidth={1.5} className={styles.fsCrumbSep} />}
              <span className={i === breadcrumbs.length - 1 ? styles.fsCrumbActive : styles.fsCrumbItem}>{seg}</span>
            </React.Fragment>
          ))}
        </div>
        <div className={styles.fsList}>
          {dirs.length === 0 ? (<p className={styles.fsEmpty}>No subdirectories</p>) : (
            dirs.map((d) => (<button key={d} className={styles.fsItem} onClick={() => browse(current + '/' + d)}><FolderClosed size={15} strokeWidth={1.5} className={styles.fsItemIcon} /><span>{d}</span></button>))
          )}
        </div>
        <div className={styles.fsManualRow}>
          <input className={styles.fsInput} value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/project" onKeyDown={(e) => { if (e.key === 'Enter') props.onConfirm(manualPath) }} />
        </div>
        <div className={styles.modalActions}>
          <button className={styles.btnPrimary} onClick={() => props.onConfirm(manualPath)}>Select Directory</button>
          <button className={styles.btnSecondary} onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
