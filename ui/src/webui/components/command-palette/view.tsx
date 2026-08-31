import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Search, MessageSquare, Palette, Settings, Plus, Trash2, Command as CommandIcon } from 'lucide-react'
import { COMMANDS, parseCommand } from '../../../shared/commands'
import { THEMES } from '../../app/view-state'
import type { ThemeName, SessionItem } from '../../app/view-state'
import type { UiPort } from '@dogegg/bridge'
import styles from './command-palette.module.css'

// 命令面板（Cmd/Ctrl+K）：搜索命令 / 会话 / 主题 / 动作。
// 玻璃拟态遮罩 + 居中偏上卡片，图标方块 + 双行文字 + 底部快捷键提示。
interface CommandPaletteProps {
  sessions: SessionItem[]
  activeSessionId: string
  theme: ThemeName
  onThemeChange: (theme: ThemeName) => void
  onNewSession: (cwd?: string) => void
  onResumeSession: (id: string) => void
  onOpenSettings: () => void
  onClearHistory: () => void
  onClose: () => void
  port: UiPort
}

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

interface PaletteItem {
  id: string
  group: string
  icon: IconType
  label: string
  desc: string
  run: () => void
}

const GROUPS = ['Commands', 'Sessions', 'Themes', 'Actions'] as const

export function CommandPalette({
  sessions, activeSessionId, theme, onThemeChange,
  onNewSession, onResumeSession, onOpenSettings, onClearHistory, onClose, port,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  const allItems: PaletteItem[] = [
    ...COMMANDS.map((c) => ({
      id: 'cmd-' + c.cmd,
      group: 'Commands',
      icon: CommandIcon,
      label: c.cmd,
      desc: c.desc,
      run: () => {
        if (c.cmd === '/clear') { onClearHistory(); return }
        if (c.cmd === '/config' || c.cmd === '/model') { onOpenSettings(); return }
        const result = parseCommand(c.cmd)
        if (result.kind === 'message') port.post(result.msg)
        onClose()
      },
    })),
    ...sessions.slice(0, 10).map((s) => ({
      id: 'sess-' + s.id,
      group: 'Sessions',
      icon: MessageSquare,
      label: s.preview || s.id,
      desc: s.id === activeSessionId ? 'Active session' : (s.cwd?.split(/[/\\]/).pop() ?? ''),
      run: () => { onResumeSession(s.id); onClose() },
    })),
    ...THEMES.map((t) => ({
      id: 'theme-' + t.theme,
      group: 'Themes',
      icon: Palette,
      label: t.label,
      desc: t.theme === theme ? 'Active' : 'Switch theme',
      run: () => { onThemeChange(t.theme); onClose() },
    })),
    { id: 'act-settings', group: 'Actions', icon: Settings, label: 'Open Settings', desc: 'Provider, model, permissions', run: () => onOpenSettings() },
    { id: 'act-clear', group: 'Actions', icon: Trash2, label: 'Clear History', desc: 'Clear messages in this session', run: () => onClearHistory() },
    { id: 'act-new', group: 'Actions', icon: Plus, label: 'New Session', desc: 'Start a fresh session', run: () => { onNewSession(); onClose() } },
  ]

  const q = query.trim().toLowerCase()
  const filtered = allItems
    .filter((it) => !q || it.label.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q))
    .map((it, idx) => ({ ...it, idx }))

  const activeIdx = filtered.length === 0 ? -1 : Math.min(selected, filtered.length - 1)

  const execute = (idx: number) => {
    const item = filtered[idx]
    if (item) item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); execute(activeIdx) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const el = resultsRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, query])

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.palette + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.searchRow}>
          <Search size={16} strokeWidth={1.5} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            autoFocus
            value={query}
            placeholder="Search commands, sessions, themes..."
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={onKeyDown}
          />
          <span className={styles.escKey}>ESC</span>
        </div>
        <div className={styles.results} ref={resultsRef}>
          {filtered.length === 0 ? (
            <p className={styles.empty}>No results</p>
          ) : (
            GROUPS.map((g) => {
              const groupItems = filtered.filter((it) => it.group === g)
              if (groupItems.length === 0) return null
              return (
                <div className={styles.group} key={g}>
                  <div className={styles.groupLabel}>{g}</div>
                  {groupItems.map((it) => {
                    const ItemIcon = it.icon
                    const active = it.idx === activeIdx
                    return (
                      <button
                        key={it.id}
                        className={active ? styles.item + ' ' + styles.itemActive : styles.item}
                        data-active={active ? 'true' : undefined}
                        onClick={() => execute(it.idx)}
                      >
                        <span className={styles.itemIcon}><ItemIcon size={14} strokeWidth={1.5} /></span>
                        <span className={styles.itemText}>
                          <span className={styles.itemLabel}>{it.label}</span>
                          <span className={styles.itemDesc}>{it.desc}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
        <div className={styles.footer}>
          <span className={styles.footerHint}><span className={styles.footerKey}>↑↓</span> navigate</span>
          <span className={styles.footerHint}><span className={styles.footerKey}>↵</span> select</span>
          <span className={styles.footerHint}><span className={styles.footerKey}>ESC</span> close</span>
        </div>
      </div>
    </div>
  )
}
