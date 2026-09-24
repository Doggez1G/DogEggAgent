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
  /** 会话 cwd——@path 补全的候选来源（仅 cwd 内提供）。 */
  cwd?: string
  /** skills 动态命令（斜杠联想 + /name 调用路由）。 */
  skills?: { name: string; description: string }[]
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

export function InputBar({ port, isRunning, cwd, skills, onCommandNav, onClearHistory, onQuit, onUserSubmit, onNewSession, onCompact, onAddProject, onCommandFeedback, onPostError, retryText, onRetryConsumed }: InputBarProps) {
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

  const skillCommands = (skills ?? []).map((s) => ({ cmd: '/' + s.name, desc: `skill: ${s.description}` }))
  const matches = input.startsWith('/') ? matchCommands(input, skillCommands) : []

  // ── @path 补全（M2.5）：输入末尾 @<路径片段> 时给 cwd 内候选；立法只限 cwd 内（与权限作用域一致）。
  // 逐层下钻：片段按最后一个 `/` 拆成目录部分 + 名字部分，目录部分解析为 cwd 内子目录再列候选
  //（完成目录补尾 `/`，继续输入即下钻）；`..`/绝对路径/盘符片段越界 → 无候选（浏览器端无 realpath，
  // 越界校验在词法层完成；服务端权限系统仍兜底实际工具调用）。
  const [atMatches, setAtMatches] = useState<{ name: string; isDir: boolean }[]>([])
  const [atIdx, setAtIdxState] = useState<number | null>(null)
  const atIdxRef = useRef<number | null>(null)
  const setAtIdx = useCallback((i: number | null) => { atIdxRef.current = i; setAtIdxState(i) }, [])
  // 目录列表缓存：按目录绝对路径缓存（逐层下钻会访问多个目录），TTL 内复用避免逐键请求。
  const fsCacheRef = useRef<Map<string, { at: number; entries: { name: string; isDir: boolean }[] }>>(new Map())
  // cwd 切换（会话/项目切换）时清空目录缓存——旧目录的候选不该出现在新 cwd 的联想里。
  useEffect(() => { fsCacheRef.current.clear() }, [cwd])
  // 键盘导航时高亮候选滚入可视区（候选全量展示后容器可滚动，光标不能滚出视野）。
  const activeAtRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { activeAtRef.current?.scrollIntoView({ block: 'nearest' }) }, [atIdx])
  // 斜杠联想（含 skills 动态命令）同款：键盘上下选择时高亮项滚入可视区。
  const activeSuggestRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { activeSuggestRef.current?.scrollIntoView({ block: 'nearest' }) }, [suggestIdx])
  const latestValue = useRef(input)
  const FS_CACHE_TTL_MS = 3000

  // 检测输入末尾的 @<路径片段>；@ 前须是行首/空白（避免误匹配邮箱）。
  // 返回目录部分/名字部分/替换起点（名字部分起始下标，补全保留已输入的目录前缀）；目录部分越界（..、绝对、盘符）返回 null。
  const atFragment = (value: string): { dirPart: string; namePart: string; start: number } | null => {
    const m = /(?:^|\s)@([\w./\-]*)$/.exec(value)
    if (!m) return null
    const frag = m[1]!
    const slash = frag.lastIndexOf('/')
    const dirPart = slash >= 0 ? frag.slice(0, slash) : ''
    const namePart = slash >= 0 ? frag.slice(slash + 1) : frag
    if (dirPart.startsWith('/') || /^[a-zA-Z]:/.test(dirPart) || dirPart.split('/').includes('..')) return null
    return { dirPart, namePart, start: m.index + m[0].length - namePart.length }
  }

  // 目录部分的请求地址：cwd 拼接相对目录部分（cwd 已由 UI 限定在项目内）。
  const dirUrl = (dirPart: string): string => {
    const base = (cwd ?? '').replace(/[\\/]+$/, '')
    return dirPart === '' ? base : `${base}/${dirPart}`
  }

  // 用当前输入的 @片段 过滤候选并展示（缓存命中时同步，未命中时异步拉取后补）。
  const refreshAt = (value: string): void => {
    const frag = atFragment(value)
    if (!frag || !cwd) { setAtMatches([]); setAtIdx(null); return }
    const dirPath = dirUrl(frag.dirPart)
    const apply = (entries: { name: string; isDir: boolean }[], prefix: string): void => {
      // token 恰好等于某个已有文件 → 补全终结，关闭弹框（文件没有下一层；目录候选名带尾 / 不会误中）。
      if (prefix !== '' && entries.some((e) => !e.isDir && e.name.toLowerCase() === prefix)) {
        setAtMatches([]); setAtIdx(null)
        return
      }
      // 目录在前、文件在后，各自字母序，**全量返回不截断**——展示由容器 max-height + 滚动承载。
      const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1)
      const list = [
        ...entries.filter((e) => e.isDir && e.name.toLowerCase().startsWith(prefix)).sort(byName),
        ...entries.filter((e) => !e.isDir && e.name.toLowerCase().startsWith(prefix)).sort(byName),
      ]
      setAtMatches(list)
      setAtIdx(list.length > 0 ? 0 : null)
    }
    const hit = fsCacheRef.current.get(dirPath)
    if (hit && Date.now() - hit.at < FS_CACHE_TTL_MS) { apply(hit.entries, frag.namePart.toLowerCase()); return }
    setAtMatches([]); setAtIdx(null)
    void (async () => {
      try {
        const res = await fetch(`/api/fs?path=${encodeURIComponent(dirPath)}&files=true`)
        if (!res.ok) return
        const data = await res.json() as { dirs?: string[]; files?: string[] }
        const entries = [
          ...(data.dirs ?? []).map((d) => ({ name: d + '/', isDir: true })),
          ...(data.files ?? []).map((f) => ({ name: f, isDir: false })),
        ]
        fsCacheRef.current.set(dirPath, { at: Date.now(), entries })
        // 拉取期间输入可能已变化——目录一致才补，且按最新输入的名字部分过滤（防旧响应覆盖新状态）。
        const latest = atFragment(latestValue.current)
        if (!latest || dirUrl(latest.dirPart) !== dirPath) return
        apply(entries, latest.namePart.toLowerCase())
      } catch { setAtMatches([]) }
    })()
  }

  // 补全插入：只替换末尾的名字部分（保留 '@' 与已输入的目录前缀），目录补尾 / 后继续输入即下钻。
  // 插入后立即按新输入刷新候选——目录候选直接列出子层（弹框不中断），文件候选按终结规则关闭。
  const insertAt = (name: string): void => {
    const frag = atFragment(input)
    if (!frag) return
    const next = input.slice(0, frag.start) + name
    setInput(next)
    latestValue.current = next
    refreshAt(next)
  }

  const handleSubmit = useCallback(() => {
    if (matches.length > 0 && suggestIdxRef.current !== null) {
      const picked = matches[suggestIdxRef.current]
      if (picked) { setInput(picked.cmd); setSuggest(null) }
      return
    }
    const result = parseCommand(input, (skills ?? []).map((s) => s.name))
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
      else if (cmd === '/rename') { onCommandFeedback?.('/rename') }
      else if (cmd === '/skills') { onCommandFeedback?.('/skills') }
      else if (cmd === '/mcp') { onCommandFeedback?.('/mcp') }
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
    // @path 菜单导航（优先于 slash 联想——两者首字符互斥）：↑↓ 选择、Tab/回车插入、esc 关闭。
    if (atMatches.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIdx(atIdxRef.current === null ? atMatches.length - 1 : (atIdxRef.current - 1 + atMatches.length) % atMatches.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIdx(atIdxRef.current === null ? 0 : (atIdxRef.current + 1) % atMatches.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        const idx = atIdxRef.current ?? 0
        const picked = atMatches[idx]
        if (picked) insertAt(picked.name)
        return
      }
      if (e.key === 'Escape') { setAtMatches([]); setAtIdx(null); return }
    }
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
      // 中文输入法组词确认的 Enter（isComposing）不提交——否则选字回车会误发消息。
      if (e.nativeEvent.isComposing) return
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
              ref={i === suggestIdx ? activeSuggestRef : undefined}
              className={`${styles.suggestItem} ${i === suggestIdx ? styles.suggestActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); setInput(m.cmd); setSuggest(null) }}
            >
              <span className={styles.suggestCmd}>{m.cmd}</span>
              <span className={styles.suggestDesc}>{m.desc}</span>
            </div>
          ))}
        </div>
      )}
      {atMatches.length > 0 && (
        <div className={styles.suggestions}>
          {atMatches.map((m, i) => (
            <div
              key={m.name}
              ref={i === atIdx ? activeAtRef : undefined}
              className={`${styles.suggestItem} ${i === atIdx ? styles.suggestActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertAt(m.name) }}
            >
              <span className={styles.suggestCmd}>{m.name}</span>
              <span className={styles.suggestDesc}>{m.isDir ? 'directory' : 'file'}</span>
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
            latestValue.current = e.target.value
            setSuggest(null)
            refreshAt(e.target.value)
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
