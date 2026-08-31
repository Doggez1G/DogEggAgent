import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { marked } from 'marked'
import { ChevronRight, FolderClosed, FolderUp, ArrowLeft, X } from 'lucide-react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import { Sidebar, TopBar, ChatView, InputBar, StatusBar, Settings, Sessions } from '../components'
import { reducer, type ChatState } from '../../shared/reducer'
import type { Block } from '../../shared/block'
import type { Panel, SettingsTab, ThemeName, Modal } from './view-state'
import { COMMAND_TO_NAV } from './view-state'
import styles from './app.module.css'

// App 是 WebUI 的唯一入口。通过 UiPort 收发消息，不依赖 Agent——与 TUI 的 App 对称。
// 单一布局：侧栏（可收起）+ 顶栏 + 主面板 + 输入区。
interface AppProps {
  port: UiPort
}

const initialState: ChatState = { blocks: [], status: 'idle', partial: null }
marked.setOptions({ breaks: true, gfm: true })

export function App({ port }: AppProps) {
  const [chat, dispatch] = useReducer(reducer, initialState)
  const [panel, setPanel] = useState<Panel>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [theme, setTheme] = useState<ThemeName>('catppuccin')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [cwd, setCwd] = useState('')
  const [statusBar, setStatusBar] = useState<{ provider?: string; model?: string; tokens?: number; windowTokens?: number }>({})
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  const [contextState, setContextState] = useState<{ estimatedTokens: number; windowTokens: number; percent: number } | null>(null)
  const [systemState, setSystemState] = useState<{ path: string; content: string } | null>(null)
  const [logState, setLogState] = useState<{ path: string; tail: string } | null>(null)
  const [permissionsList, setPermissionsList] = useState<string[]>([])

  const modalRef = useRef(modal)
  useEffect(() => { modalRef.current = modal }, [modal])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const onCommandNav = useCallback((cmd: string) => {
    const nav = COMMAND_TO_NAV[cmd]
    if (nav?.panel) {
      setPanel(nav.panel)
      if (nav.settingsTab) setSettingsTab(nav.settingsTab)
    }
    if (nav?.modal) {
      setModal({ kind: nav.modal })
    }
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
        setStatusBar({ provider: msg.provider, model: msg.model, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens })
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
      }
    })
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
    return off
  }, [port])

  const isRunning = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'

  const renderBlocks = chat.blocks.map((b: Block) => ({
    ...b,
    html: b.kind === 'assistant' || b.kind === 'thinking' ? marked.parse(b.text) : b.text,
    fullHtml: b.full !== undefined ? (b.kind === 'assistant' || b.kind === 'thinking' ? marked.parse(b.full) : b.full) : undefined,
  }))
  const partialHtml = chat.partial ? marked.parse(chat.partial.text) : null

  return (
    <div className={styles.app} data-collapsed={sidebarCollapsed}>
      <Sidebar
        panel={panel}
        cwd={cwd}
        isRunning={isRunning}
        theme={theme}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onPanelChange={setPanel}
        onNewSession={() => port.post({ type: 'new_session' })}
        onThemeChange={setTheme}
        onCdClick={() => setModal({ kind: 'fs-browser' })}
      />
      <TopBar provider={statusBar.provider} model={statusBar.model} cwd={cwd} isRunning={isRunning} />
      <div className={styles.mainArea}>
        {panel === 'chat' ? (
          <ChatView chat={{ ...chat, blocks: renderBlocks as unknown as Block[], partial: chat.partial ? { ...chat.partial, html: partialHtml } : null } as unknown as ChatState} isRunning={isRunning} />
        ) : panel === 'sessions' ? (
          <Sessions port={port} onBack={() => setPanel('chat')} />
        ) : (
          <Settings
            tab={settingsTab}
            config={config}
            port={port}
            toolsList={toolsList}
            contextState={contextState}
            systemState={systemState}
            logState={logState}
            permissionsList={permissionsList}
            onTabChange={setSettingsTab}
            onBack={() => setPanel('chat')}
          />
        )}
      </div>

      <div className={styles.inputArea}>
        <StatusBar status={chat.status} tokens={statusBar.tokens} windowTokens={statusBar.windowTokens} />
        <InputBar port={port} isRunning={isRunning} onCommandNav={onCommandNav} onClearHistory={onClearHistory} onQuit={onQuit} />
      </div>

      {/* 模态层 */}
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
        <FsBrowserModal onConfirm={(p) => { port.post({ type: 'set_cwd', path: p }); setModal({ kind: 'none' }) }} onClose={() => setModal({ kind: 'none' })} />
      )}
    </div>
  )
}

// ── 模态组件 ──

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
    ['/new', 'New session'], ['/session', 'Switch session'], ['/config', 'Edit config'],
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
          {history.length > 0 && (
            <button className={styles.fsBackBtn} onClick={goBack} aria-label="Go back"><ArrowLeft size={14} strokeWidth={1.5} /></button>
          )}
          {parent && (
            <button className={styles.fsCrumbUp} onClick={() => browse(parent)} title="Go up"><FolderUp size={14} strokeWidth={1.5} /></button>
          )}
          {breadcrumbs.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={10} strokeWidth={1.5} className={styles.fsCrumbSep} />}
              <span className={i === breadcrumbs.length - 1 ? styles.fsCrumbActive : styles.fsCrumbItem}>{seg}</span>
            </React.Fragment>
          ))}
        </div>
        <div className={styles.fsList}>
          {dirs.length === 0 ? (
            <p className={styles.fsEmpty}>No subdirectories</p>
          ) : (
            dirs.map((d) => (
              <button key={d} className={styles.fsItem} onClick={() => browse(current + '/' + d)}>
                <FolderClosed size={15} strokeWidth={1.5} className={styles.fsItemIcon} />
                <span>{d}</span>
              </button>
            ))
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
