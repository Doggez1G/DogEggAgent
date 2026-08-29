import React, { useCallback, useEffect, useReducer, useState } from 'react'
import type { AgentToUiMessage, Config, UiPort } from '@dogegg/bridge'
import { Sidebar, TopBar, ChatView, InputBar, StatusBar, Settings, Sessions } from '../components'
import { reducer, type ChatState } from '../../shared/reducer'
import type { Panel, SettingsTab, ThemeName, LayoutName, Modal } from './view-state'
import { COMMAND_TO_NAV } from './view-state'
import styles from './app.module.css'

// App 是 WebUI 的唯一入口。通过 UiPort 收发消息，不依赖 Agent——与 TUI 的 App 对称。
// 后端消息经 port.onMessage → dispatch(reducer) + panel/modal 路由。
// 用户输入经 port.post 发给后端。侧栏点击和斜杠命令发送相同的 UiToAgentMessage。
interface AppProps {
  port: UiPort
}

const initialState: ChatState = { blocks: [], status: 'idle', partial: null }

export function App({ port }: AppProps) {
  const [chat, dispatch] = useReducer(reducer, initialState)
  const [panel, setPanel] = useState<Panel>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [theme, setTheme] = useState<ThemeName>('catppuccin')
  const [layout, setLayout] = useState<LayoutName>('focus')
  const [config, setConfig] = useState<Config | null>(null)
  const [cwd, setCwd] = useState('')
  const [statusBar, setStatusBar] = useState<{ provider?: string; model?: string; tokens?: number; windowTokens?: number }>({})
  // 设置面板各标签页的数据（由后端消息响应填充）。
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  const [contextState, setContextState] = useState<{ estimatedTokens: number; windowTokens: number; percent: number } | null>(null)
  const [systemState, setSystemState] = useState<{ path: string; content: string } | null>(null)
  const [logState, setLogState] = useState<{ path: string; tail: string } | null>(null)
  const [permissionsList, setPermissionsList] = useState<string[]>([])

  // 应用 theme + layout 到 <html> 的 data 属性。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.setAttribute('data-layout', layout)
  }, [layout])

  // 命令导航：斜杠命令输入后切换到对应面板/设置标签。
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

  // /clear 和 /quit 的确认弹窗。
  const onClearHistory = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Clear History', message: 'Clear all messages in the current session? This cannot be undone.', onConfirm: () => { port.post({ type: 'clear_history' }); setModal({ kind: 'none' }) } })
  }, [port])

  const onQuit = useCallback(() => {
    setModal({ kind: 'confirm', title: 'Quit', message: 'Close the browser tab to quit DogEggAgent WebUI.', onConfirm: () => { setModal({ kind: 'none' }) } })
  }, [])

  // 订阅后端消息：dispatch 到 reducer + 按 msg.type 切换 panel/modal。
  useEffect(() => {
    const off = port.onMessage((msg: AgentToUiMessage) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setModal({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && modal.kind === 'permission') {
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
    // 订阅后主动取一次配置。
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
    return off
  }, [port, modal])

  const isRunning = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'

  return (
    <div className={styles.app} data-layout={layout}>
      {layout !== 'zen' && (
        <Sidebar
          panel={panel}
          cwd={cwd}
          isRunning={isRunning}
          layout={layout}
          theme={theme}
          onPanelChange={setPanel}
          onNewSession={() => port.post({ type: 'new_session' })}
          onLayoutChange={setLayout}
          onThemeChange={setTheme}
          onCdClick={() => setModal({ kind: 'fs-browser' })}
        />
      )}
      <TopBar provider={statusBar.provider} model={statusBar.model} cwd={cwd} isRunning={isRunning} />
      <div className={styles.mainArea}>
        {panel === 'chat' ? (
          <ChatView chat={chat} isRunning={isRunning} />
        ) : panel === 'sessions' ? (
          <Sessions port={port} />
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
          />
        )}
      </div>
      <div className={styles.inputArea}>
        <StatusBar status={chat.status} tokens={statusBar.tokens} windowTokens={statusBar.windowTokens} />
        <InputBar port={port} isRunning={isRunning} onCommandNav={onCommandNav} onClearHistory={onClearHistory} onQuit={onQuit} />
      </div>

      {/* 模态层 */}
      {modal.kind === 'permission' && (
        <PermissionModal
          id={modal.id}
          tool={modal.tool}
          input={modal.input}
          onDecision={(decision) => { port.post({ type: 'permission_decision', id: modal.id, decision }); setModal({ kind: 'none' }) }}
          onClose={() => { port.post({ type: 'permission_decision', id: modal.id, decision: 'reject' }); setModal({ kind: 'none' }) }}
        />
      )}
      {modal.kind === 'confirm' && (
        <ConfirmModal title={modal.title} message={modal.message} onConfirm={modal.onConfirm} onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'help' && (
        <HelpModal onClose={() => setModal({ kind: 'none' })} />
      )}
      {modal.kind === 'fs-browser' && (
        <FsBrowserModal
          onConfirm={(path) => { port.post({ type: 'set_cwd', path }); setModal({ kind: 'none' }) }}
          onClose={() => setModal({ kind: 'none' })}
        />
      )}
    </div>
  )
}

// ── 模态组件（P3 骨架版，P4 细化）──

function PermissionModal(props: { id: string; tool: string; input: unknown; onDecision: (d: 'allow_once' | 'allow_always' | 'reject') => void; onClose: () => void }) {
  const inp = props.input as Record<string, unknown> | null
  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>Permission: {props.tool}</h2>
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
        <h2 className={styles.modalTitle}>{props.title}</h2>
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
        <h2 className={styles.modalTitle}>Commands</h2>
        <div className={styles.helpGrid}>
          {commands.map(([cmd, desc]) => (
            <React.Fragment key={cmd}>
              <code className={styles.helpCmd}>{cmd}</code>
              <span className={styles.helpDesc}>{desc}</span>
            </React.Fragment>
          ))}
        </div>
        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={props.onClose}>Close</button>
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

  useEffect(() => {
    fetch('/api/fs').then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }, [])

  const browse = (path: string) => {
    fetch(`/api/fs?path=${encodeURIComponent(path)}`).then((r) => r.json()).then((d) => { setCurrent(d.current); setDirs(d.dirs); setParent(d.parent); setManualPath(d.current) })
  }

  return (
    <div className={styles.scrim} onClick={props.onClose}>
      <div className={styles.modal + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>Select Working Directory</h2>
        <p className={styles.modalMessage}>{current}</p>
        <div className={styles.fsList}>
          {parent && <button className={styles.fsItem} onClick={() => browse(parent)}>..</button>}
          {dirs.map((d) => (
            <button key={d} className={styles.fsItem} onClick={() => browse(current + '/' + d)}>{d}</button>
          ))}
        </div>
        <input className={styles.fsInput} value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/path/to/project" />
        <div className={styles.modalActions}>
          <button className={styles.btnPrimary} onClick={() => props.onConfirm(manualPath)}>Select</button>
          <button className={styles.btnSecondary} onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
