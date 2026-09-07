import { useCallback, useEffect, useState } from 'react'
import type { Config, UiPort } from '@dogegg/bridge'

// 右侧信息面板的数据域：配置、状态栏、六类面板数据 + 会话恢复后的刷新风暴。
// 独立订阅 port——只关心 config_state/config_updated/status_state/session_ready/
// tools_list/context_state/system_state/log_state/permissions_list/compaction/finished/error。
export function usePanelData(port: UiPort): {
  config: Config | null
  statusBar: { provider?: string; model?: string; tokens?: number; windowTokens?: number }
  cwd: string
  sessionId: string
  toolsList: { name: string; description: string }[]
  contextState: { estimatedTokens: number; windowTokens: number; percent: number } | null
  systemState: { path: string; content: string } | null
  logState: { path: string; tail: string } | null
  permissionsList: string[]
  refreshContext(): void
  refreshLog(): void
} {
  const [config, setConfig] = useState<Config | null>(null)
  const [cwd, setCwd] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [statusBar, setStatusBar] = useState<{ provider?: string; model?: string; tokens?: number; windowTokens?: number }>({})
  const [toolsList, setToolsList] = useState<{ name: string; description: string }[]>([])
  const [contextState, setContextState] = useState<{ estimatedTokens: number; windowTokens: number; percent: number } | null>(null)
  const [systemState, setSystemState] = useState<{ path: string; content: string } | null>(null)
  const [logState, setLogState] = useState<{ path: string; tail: string } | null>(null)
  const [permissionsList, setPermissionsList] = useState<string[]>([])

  const refreshContext = useCallback(() => { port.post({ type: 'context_request' }) }, [port])
  const refreshLog = useCallback(() => { port.post({ type: 'log_request' }) }, [port])

  useEffect(() => {
    const off = port.onMessage((msg) => {
      if (msg.type === 'config_state' || msg.type === 'config_updated') {
        setConfig(msg.config)
      } else if (msg.type === 'status_state') {
        setCwd(msg.cwd)
        setSessionId(msg.sessionId)
        setStatusBar({ provider: msg.provider, model: msg.model, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens })
      } else if (msg.type === 'session_ready') {
        setSessionId(msg.id)
        // 清除旧会话的右侧面板数据——新会话的数据需要重新请求。
        setContextState(null)
        setSystemState(null)
        setLogState(null)
        setPermissionsList([])
        // 请求新会话的实时状态 + 右侧面板数据（不依赖 InfoPanel 的 effect timing）。
        port.post({ type: 'status_request' })
        port.post({ type: 'context_request' })
        port.post({ type: 'system_request' })
        port.post({ type: 'log_request' })
        port.post({ type: 'tools_request' })
        port.post({ type: 'permissions_request' })
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
      } else if (msg.type === 'compaction') {
        port.post({ type: 'context_request' })
      }
    })
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
    return off
  }, [port])

  return { config, statusBar, cwd, sessionId, toolsList, contextState, systemState, logState, permissionsList, refreshContext, refreshLog }
}
