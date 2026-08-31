import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Search, MessageSquare, Palette, Settings, Plus, Trash2, Command } from 'lucide-react'
import { COMMANDS, parseCommand } from '../../../shared/commands'
import { THEMES } from '../../app/view-state'
import type { ThemeName, SessionItem } from '../../app/view-state'
import type { UiPort } from '@dogegg/bridge'
import styles from './command-palette.module.css'

// 命令面板（Cmd/Ctrl+K）：搜索命令 / 会话 / 主题 / 动作，键盘上下导航 + Enter 执行 + Esc 关闭。
// 玻璃拟态遮罩 + 居中（略偏上）卡片。执行任意动作后关闭——但 /clear、/config 会切换 modal，
// 由 onClearHistory/onOpenSettings 自身替换面板，故不再追加 onClose（否则会把新弹出的 confirm/settings 一起关掉）。
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

// 分组顺序（同时决定渲染顺序）。
const GROUPS = ['Commands', 'Sessions', 'Themes', 'Actions'] as const

export function CommandPalette({
  sessions,
  activeSessionId,
  theme,
  onThemeChange,
  onNewSession,
  onResumeSession,
  onOpenSettings,
  onClearHistory,
  onClose,
  port,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  // 选中索引用 useState：导航时需触发重渲染以更新高亮（useRef 不触发重渲染，高亮不会跟随移动）。
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // 构建全部条目（每次渲染重建以捕获最新的 props 闭包）。每个 run 自行决定是否 onClose。
  const allItems: PaletteItem[] = [
    ...COMMANDS.map((c) => ({
      id: 'cmd-' + c.cmd,
      group: 'Commands',
      icon: Command,
      label: c.cmd,
      desc: c.desc,
      run: () => {
        // /clear、/config 会切换 modal（confirm / settings），交由对应回调处理，不再 onClose。
        if (c.cmd === '/clear') {
          onClearHistory()
          return
        }
        if (c.cmd === '/config') {
          onOpenSettings()
          return
        }
        const result = parseCommand(c.cmd)
        if (result.kind === 'message') port.post(result.msg)
        onClose()
      },
    })),
    ...sessions.map((s) => ({
      id: 'sess-' + s.id,
      group: 'Sessions',
      icon: MessageSquare,
      label: s.preview || s.id,
      desc: s.id === activeSessionId ? 'Active' : (s.cwd ?? s.updatedAt),
      run: () => {
        onResumeSession(s.id)
        onClose()
      },
    })),
    ...THEMES.map((t) => ({
      id: 'theme-' + t.theme,
      group: 'Themes',
      icon: Palette,
      label: t.label,
      desc: t.theme === theme ? 'Active' : 'Switch theme',
      run: () => {
        onThemeChange(t.theme)
        onClose()
      },
    })),
    {
      id: 'act-settings',
      group: 'Actions',
      icon: Settings,
      label: 'Open Settings',
      desc: 'Provider, model, permissions',
      run: () => onOpenSettings(), // 切换到 settings modal，不 onClose
    },
    {
      id: 'act-clear',
      group: 'Actions',
      icon: Trash2,
      label: 'Clear History',
      desc: 'Clear messages in this session',
      run: () => onClearHistory(), // 切换到 confirm modal，不 onClose
    },
    {
      id: 'act-new',
      group: 'Actions',
      icon: Plus,
      label: 'New Session',
      desc: 'Start a fresh session',
      run: () => {
        onNewSession()
        onClose()
      },
    },
  ]

  // 按查询过滤（label/desc 简单 includes，大小写不敏感），并附上扁平索引供高亮/执行。
  const q = query.trim().toLowerCase()
  const filtered = allItems
    .filter((it) => !q || it.label.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q))
    .map((it, idx) => ({ ...it, idx }))

  const activeIdx = filtered.length === 0 ? -1 : Math.min(selected, filtered.length - 1)

  const execute = (idx: number) => {
    const item = filtered[idx]
    if (!item) return
    item.run()
  }

  const onKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(activeIdx)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // 挂载时聚焦输入框；选中/查询变化时把高亮项滚入视口。
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = resultsRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, query])

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.palette + ' modal-enter'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.searchRow}>
          <Search size={14} strokeWidth={1.5} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            autoFocus
            value={query}
            placeholder="Search commands, sessions, themes..."
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
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
                        <ItemIcon size={14} strokeWidth={1.5} className={styles.itemIcon} />
                        <span className={styles.itemLabel}>{it.label}</span>
                        <span className={styles.itemDesc}>{it.desc}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
