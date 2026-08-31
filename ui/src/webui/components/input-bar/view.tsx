import React, { useState, useRef, useCallback } from 'react'
import { ArrowUp, Square, Slash, MessageSquare } from 'lucide-react'
import { matchCommands, parseCommand } from '../../../shared/commands'
import { COMMAND_TO_MODAL } from '../../app/view-state'
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
}

export function InputBar({ port, isRunning, onCommandNav, onClearHistory, onQuit, onUserSubmit }: InputBarProps) {
  const [input, setInput] = useState('')
  const [suggestIdx, setSuggestIdx] = useState<number | null>(null)
  const suggestIdxRef = useRef<number | null>(null)
  const setSuggest = useCallback((i: number | null) => { suggestIdxRef.current = i; setSuggestIdx(i) }, [])

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
      port.post({ type: 'submit', text: result.text })
    } else if (result.kind === 'message') {
      const cmd = input.trim().split(/\s+/)[0] ?? ''
      if (result.msg.type === 'clear_history') { onClearHistory(); setInput(''); setSuggest(null); return }
      if (result.msg.type === 'quit') { onQuit(); setInput(''); setSuggest(null); return }
      const nav = COMMAND_TO_MODAL[cmd]
      if (nav) { onCommandNav(cmd) }
      port.post(result.msg)
    }
    setInput('')
    setSuggest(null)
  }, [input, matches, port, onCommandNav, onClearHistory, onQuit, onUserSubmit, setSuggest])

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
          <button className={styles.toolBtn} title="Slash commands" aria-label="Slash commands" onClick={() => { setInput('/'); }}>
            <Slash size={13} strokeWidth={1.5} />
          </button>
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
