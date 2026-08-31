import React, { useState, useRef, useCallback } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { matchCommands, parseCommand } from '../../../shared/commands'
import { COMMAND_TO_NAV } from '../../app/view-state'
import type { UiPort } from '@dogegg/bridge'
import styles from './input-bar.module.css'

// 输入栏：文本输入 + 斜杠命令联想 + 发送/停止按钮。
// 斜杠命令输入后导航到对应面板而非弹 overlay（与 TUI 的 overlay 模式不同）。
interface InputBarProps {
  port: UiPort
  isRunning: boolean
  onCommandNav: (cmd: string) => void
  onClearHistory: () => void
  onQuit: () => void
}

export function InputBar({ port, isRunning, onCommandNav, onClearHistory, onQuit }: InputBarProps) {
  const [input, setInput] = useState('')
  const [suggestIdx, setSuggestIdx] = useState<number | null>(null)
  const suggestIdxRef = useRef<number | null>(null)
  const setSuggest = useCallback((i: number | null) => { suggestIdxRef.current = i; setSuggestIdx(i) }, [])

  const matches = input.startsWith('/') ? matchCommands(input) : []

  const handleSubmit = useCallback(() => {
    // 联想补全拦截：有匹配且选中了项时，补全到输入框而非提交。
    if (matches.length > 0 && suggestIdxRef.current !== null) {
      setInput(matches[suggestIdxRef.current]!.cmd)
      setSuggest(null)
      return
    }

    const result = parseCommand(input)
    if (result.kind === 'user' && !result.text) return

    if (result.kind === 'user') {
      port.post({ type: 'submit', text: result.text })
    } else if (result.kind === 'message') {
      // 命令消息
      const cmd = input.trim().split(/\s+/)[0]!
      // /clear 和 /quit 需确认弹窗
      if (result.msg.type === 'clear_history') { onClearHistory(); setInput(''); setSuggest(null); return }
      if (result.msg.type === 'quit') { onQuit(); setInput(''); setSuggest(null); return }
      // 导航类命令：发消息 + 切面板
      const nav = COMMAND_TO_NAV[cmd]
      if (nav) {
        if (nav.panel) onCommandNav(cmd)
        else if (nav.modal) onCommandNav(cmd)
      }
      port.post(result.msg)
    }
    // result.kind === 'help' 在 parseCommand 里已处理（返回 help），此处不到达
    setInput('')
    setSuggest(null)
  }, [input, matches, port, onCommandNav, onClearHistory, onQuit, setSuggest])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 联想提示导航
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
        if (idx !== null) { setInput(matches[idx]!.cmd); setSuggest(null) }
        return
      }
      if (e.key === 'Escape') { setSuggest(null); return }
    }
    // 多行输入：Ctrl+Enter 换行，Enter 提交
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    // Ctrl+C 运行中 → 发 cancel
    if (e.ctrlKey && e.key === 'c' && isRunning) {
      e.preventDefault()
      port.post({ type: 'cancel' })
    }
  }

  return (
    <div className={styles.inputBar}>
      {matches.length > 0 && (
        <div className={styles.suggestions}>
          {matches.map((m: { cmd: string; desc: string }, i: number) => (
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
      <div className={styles.inputRow}>
        <textarea
          className={styles.textInput}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setSuggest(null)
            // 自动增高：重置 height 让 scrollHeight 计算实际内容高度。
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
          }}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? '' : 'Type a message or / for commands...'}
          rows={1}
          disabled={isRunning && !input}
        />
        {isRunning ? (
          <button className={styles.stopBtn} onClick={() => port.post({ type: 'cancel' })} aria-label="Stop">
            <Square size={16} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            className={styles.sendBtn}
            onClick={handleSubmit}
            disabled={!input.trim()}
            aria-label="Send"
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}
