import React, { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowUp, Square, Slash, MoreHorizontal, Eraser, Archive, Plus, FolderPlus } from 'lucide-react'
import { matchCommands, parseCommand } from '../../../shared'
import { COMMAND_TO_MODAL } from '../../app'
import type { UiPort } from '@dogegg/bridge'
import styles from './input-bar.module.css'

// 输入栏：容器式 textarea + focus ring + 底部工具栏 + 发送/停止按钮。
interface InputBarProps {
  port: UiPort
  isRunning: boolean
  onCommandNav: (cmd: string) => void
  onClearHistory: () => void
  onQuit: () => void
  onUserSubmit: (text: string) => void
  onNewSession?: () => void
  onCompact?: () => void
  onAddProject?: () => void
  onCommandFeedback?: (cmd: string, arg?: string) => void
  onPostError?: (error: Error) => void
  /** 错误后自动回填到输入框的文本（来自 App 追踪上次提交） */
  retryText?: string | null
  /** 回填完成后通知 App 清除 retryText */
  onRetryConsumed?: () => void
}

export function InputBar({ port, isRunning, onCommandNav, onClearHistory, onQuit, onUserSubmit, onNewSession, onCompact, onAddProject, onCommandFeedback, onPostError, retryText, onRetryConsumed }: InputBarProps) {
  const [input, setInput] = useState('')
  const [suggestIdx, setSuggestIdx] = useState<number | null>(null)
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const suggestIdxRef = useRef<number | null>(null)
  const setSuggest = useCallback((i: number | null) => { suggestIdxRef.current = i; setSuggestIdx(i) }, [])
  const quickMenuRef = useRef<HTMLDivElement>(null)
  // 输入历史——ArrowUp/Down 在输入框为空时回溯历史输入（与 TUI 行为一致）。
  const inputHistory = useRef<string[]>([])
  const historyIdx = useRef<number>(-1) // -1 = 不在历史浏览模式

  // 点击快捷菜单外部时收起。
  useEffect(() => {
    if (!quickMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setQuickMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [quickMenuOpen])

  // 错误自动重填——App 传入 retryText 时回填到输入框。
  useEffect(() => {
    if (retryText) {
      setInput(retryText)
      onRetryConsumed?.()
    }
  }, [retryText, onRetryConsumed])

  const matches = input.startsWith('/') ? matchCommands(input) : []

  const handleSubmit = useCallback(() => {
    if (matches.length > 0 && suggestIdxRef.current !== null) {
      const picked = matches[suggestIdxRef.current]
      if (picked) { setInput(picked.cmd); setSuggest(null) }
      return
    }
    const result = parseCommand(input)
    if (result.kind === 'user' && !result.text) return
    if (result.kind === 'user') {
      onUserSubmit(result.text)
      const r = port.post({ type: 'submit', text: result.text })
      if (r instanceof Promise) r.catch((e: Error) => onPostError?.(e))
      // 记录到输入历史（最多 50 条）。
      inputHistory.current.push(result.text)
      if (inputHistory.current.length > 50) inputHistory.current.shift()
      historyIdx.current = -1
    } else if (result.kind === 'help') {
      // /cd 无参数 → 打开文件选择器选目录（而非显示帮助）。
      // /help 或未知命令 → 打开帮助 modal。
      const cmd = input.trim().split(/\s+/)[0] ?? ''
      if (cmd === '/cd') { onCommandFeedback?.('/cd') }
      else { onCommandNav('/help') }
    } else if (result.kind === 'message') {
      const cmd = input.trim().split(/\s+/)[0] ?? ''
      if (result.msg.type === 'clear_history') { onClearHistory(); setInput(''); setSuggest(null); return }
      if (result.msg.type === 'quit') { onQuit(); setInput(''); setSuggest(null); return }
      // /cd 有参数 → 直接发 set_cwd 消息。
      // /cd 无参数 → 已在 help 分支处理（打开文件选择器）。
      // 纯呈现类命令 → 通过 onCommandFeedback 突出显示对应面板 section。
      if (result.msg.type === 'list_sessions') { onCommandFeedback?.('/session') }
      if (result.msg.type === 'status_request') { onCommandFeedback?.('/status') }
      if (result.msg.type === 'context_request') { onCommandFeedback?.('/context') }
      if (result.msg.type === 'tools_request') { onCommandFeedback?.('/tools') }
      if (result.msg.type === 'system_request') { onCommandFeedback?.('/system') }
      if (result.msg.type === 'log_request') { onCommandFeedback?.('/log') }
      if (result.msg.type === 'permissions_request') { onCommandFeedback?.('/permissions') }
      const nav = COMMAND_TO_MODAL[cmd]
      if (nav) { onCommandNav(cmd) }
      port.post(result.msg)
    }
    setInput('')
    setSuggest(null)
  }, [input, matches, port, onCommandNav, onClearHistory, onQuit, onUserSubmit, onCommandFeedback, setSuggest])
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (matches.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggest(suggestIdxRef.current === null ? matches.length - 1 : (suggestIdxRef.current - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggest(suggestIdxRef.current === null ? 0 : (suggestIdxRef.current + 1) % matches.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const idx = suggestIdxRef.current ?? (matches.length === 1 ? 0 : null)
        if (idx !== null) {
          const picked = matches[idx]
          if (picked) { setInput(picked.cmd); setSuggest(null) }
        }
        return
      }
      if (e.key === 'Escape') { setSuggest(null); return }
    }
    // 输入历史回溯——只在无斜杠命令联想 + 输入框为空（或在行首）时触发。
    if (e.key === 'ArrowUp' && inputHistory.current.length > 0 && (input === '' || historyIdx.current >= 0)) {
      e.preventDefault()
      const newIdx = historyIdx.current < 0
        ? inputHistory.current.length - 1
        : Math.max(0, historyIdx.current - 1)
      historyIdx.current = newIdx
      setInput(inputHistory.current[newIdx] ?? '')
      return
    }
    if (e.key === 'ArrowDown' && historyIdx.current >= 0) {
      e.preventDefault()
      const newIdx = historyIdx.current + 1
      if (newIdx >= inputHistory.current.length) {
        historyIdx.current = -1
        setInput('')
      } else {
        historyIdx.current = newIdx
        setInput(inputHistory.current[newIdx] ?? '')
      }
      return
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.ctrlKey && e.key === 'c' && isRunning) {
      e.preventDefault()
      port.post({ type: 'cancel' })
    }
  }

  return (
    <div className={styles.inputArea}>
      {matches.length > 0 && (
        <div className={styles.suggestions}>
          {matches.map((m, i) => (
            <div
              key={m.cmd}
              className={`${styles.suggestItem} ${i === suggestIdx ? styles.suggestActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); setInput(m.cmd); setSuggest(null) }}
            >
              <span className={styles.suggestCmd}>{m.cmd}</span>
              <span className={styles.suggestDesc}>{m.desc}</span>
            </div>
          ))}
        </div>
      )}
      <div className={styles.inputContainer}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setSuggest(null)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          rows={1}
          disabled={isRunning}
        />
        <div className={styles.toolbar}>
          <div className={styles.quickMenuWrap} ref={quickMenuRef}>
            <button className={styles.toolBtn} title="Quick actions" aria-label="Quick actions" onClick={() => setQuickMenuOpen(!quickMenuOpen)}>
              <MoreHorizontal size={13} strokeWidth={1.5} />
            </button>
            {quickMenuOpen && (
              <div className={styles.quickMenu}>
                <button className={styles.quickItem} onClick={() => { onNewSession?.(); setQuickMenuOpen(false) }}>
                  <Plus size={13} strokeWidth={1.5} /><span>New Session</span>
                </button>
                <button className={styles.quickItem} onClick={() => { onAddProject?.(); setQuickMenuOpen(false) }}>
                  <FolderPlus size={13} strokeWidth={1.5} /><span>Add Project</span>
                </button>
                <div className={styles.quickDivider} />
                <button className={styles.quickItem} onClick={() => { onClearHistory(); setQuickMenuOpen(false) }}>
                  <Eraser size={13} strokeWidth={1.5} /><span>Clear History</span>
                </button>
                <button className={styles.quickItem} disabled={isRunning} onClick={() => { onCompact?.(); setQuickMenuOpen(false) }}>
                  <Archive size={13} strokeWidth={1.5} /><span>Compact Context</span>
                </button>
                <div className={styles.quickDivider} />
                <button className={styles.quickItem} onClick={() => { setInput('/'); setQuickMenuOpen(false) }}>
                  <Slash size={13} strokeWidth={1.5} /><span>Slash Commands</span>
                </button>
              </div>
            )}
          </div>
          <span className={styles.hint}>Enter to send · Shift+Enter for newline</span>
          {isRunning ? (
            <button className={styles.stopBtn} onClick={() => port.post({ type: 'cancel' })} aria-label="Stop">
              <Square size={14} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button className={styles.sendBtn} onClick={handleSubmit} disabled={!input.trim()} aria-label="Send">
              <ArrowUp size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
