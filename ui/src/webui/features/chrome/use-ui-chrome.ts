import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThemeName, Modal } from '../../view-state'

// UI chrome 数据域：modal 总管、toast/highlight 计时器、面板折叠、主题、Cmd+K。
// 与数据域（chat/panel/tracking/sessions）正交——只管「界面外壳」。
export function useUiChrome(connectionState: 'connected' | 'reconnecting' | 'disconnected' | undefined): {
  modal: Modal
  setModal(modal: Modal): void
  theme: ThemeName
  setTheme(theme: ThemeName): void
  sidebarCollapsed: boolean
  setSidebarCollapsed(v: boolean): void
  infoCollapsed: boolean
  setInfoCollapsed(v: boolean): void
  toast: string | null
  showToast(msg: string): void
  highlightSection: string | null
  highlightInfoSection(section: string): void
} {
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [theme, setTheme] = useState<ThemeName>('midnight')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [infoCollapsed, setInfoCollapsed] = useState(false)
  const [highlightSection, setHighlightSection] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // 主题 → CSS 变量（data-theme 属性）。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

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

  return {
    modal, setModal, theme, setTheme,
    sidebarCollapsed, setSidebarCollapsed,
    infoCollapsed, setInfoCollapsed,
    toast, showToast,
    highlightSection, highlightInfoSection,
  }
}
