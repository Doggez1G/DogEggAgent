import { useEffect, useRef, useState, type ComponentType } from 'react'
import { FileText, Search, MessageSquare, Palette, Settings, Plus, Trash2, Command as CommandIcon } from 'lucide-react'
import { COMMANDS, parseCommand } from '../../../shared'
import { ModalPortal } from '../modal-portal'
import { THEMES } from '../../app'
import type { ThemeName, SessionItem } from '../../app'
import type { UiPort } from '@dogegg/bridge'
import styles from './command-palette.module.css'

// 命令面板（Cmd/Ctrl+K）：搜索命令 / 会话 / 主题 / 动作。
// 玻璃拟态遮罩 + 居中偏上卡片，图标方块 + 双行文字 + 底部快捷键提示。
interface CommandPaletteProps {
  sessions: SessionItem[]
  activeSessionId: string
  skills?: { name: string; description: string }[]
  theme: ThemeName
  onThemeChange: (theme: ThemeName) => void
  onNewSession: (cwd?: string) => void
  onResumeSession: (id: string) => void
  onOpenSettings: () => void
  onClearHistory: () => void
  onCommandFeedback?: (cmd: string) => void
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

const GROUPS = ['Commands', 'Skills', 'Sessions', 'Themes', 'Actions'] as const

// P1-10 立法：危险命令不得进入命令面板的 Commands 列表。
// /quit 直发会让 agent 侧 process.exit(0) 杀掉整个后端服务（WebUI 下等于杀服务端进程）；
// /clear 不可逆清空会话历史。二者的安全路径只有输入框——那里挂了确认弹窗
//（/quit → App.onQuit 的 ConfirmModal、/clear → App.onClearHistory 的 ConfirmModal），
// 而命令面板对 Commands 的直发链路（parseCommand → port.post）没有确认环节，Enter 即执行。
// 因此从 COMMANDS 全量列表中过滤，面板里不再出现；Actions 组的 Clear History
// 走 onClearHistory（自带确认弹窗），不在本条限制内。
const DANGEROUS_COMMANDS = new Set(['/quit', '/clear'])

export function CommandPalette({
  sessions, skills, activeSessionId, theme, onThemeChange,
  onNewSession, onResumeSession, onOpenSettings, onClearHistory, onCommandFeedback, onClose, port,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  const allItems: PaletteItem[] = [
    // P1-10：过滤 /quit /clear（见 DANGEROUS_COMMANDS 立法注释）——面板不提供直发入口。
    ...COMMANDS.filter((c) => !DANGEROUS_COMMANDS.has(c.cmd)).map((c) => ({
      id: 'cmd-' + c.cmd,
      group: 'Commands',
      icon: CommandIcon,
      label: c.cmd,
      desc: c.desc,
      run: () => {
        if (c.cmd === '/config' || c.cmd === '/model') { onOpenSettings(); return }
        // 需要参数/专用 UI 的命令：路由到与输入框一致的行为（/cd → 路径选择器，/rename → 重命名编辑框），
        // 裸 parseCommand 对它们只会得到 help（无参数），点了没反应。
        // 注意：这里不调 onClose——onCommandFeedback 打开的新 modal（路径选择器/重命名框）会
        // 替换掉命令面板本身，紧跟的 onClose 会把刚打开的弹框抹掉（与 /clear /config 同约定）。
        if (c.cmd === '/cd' || c.cmd === '/rename' || c.cmd === '/skills' || c.cmd === '/mcp') { onCommandFeedback?.(c.cmd); return }
        const result = parseCommand(c.cmd)
        if (result.kind === 'message') {
          onCommandFeedback?.(c.cmd)
          port.post(result.msg)
        }
        onClose()
      },
    })),
    ...(skills ?? []).map((s) => ({
      id: 'skill-' + s.name,
      group: 'Skills',
      icon: FileText,
      label: '/' + s.name,
      desc: s.description,
      run: () => { port.post({ type: 'invoke_skill', name: s.name, args: '' }); onClose() },
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
    // Escape 关闭由 ModalPortal 统一处理（document 级 keydown → onClose）——
    // P2-37 迁移后不再在此自绘 scrim / 自管 Escape，避免双份关闭链路。
  }

  useEffect(() => {
    const el = resultsRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, query])

  return (
    // P2-37 立法：迁移到 ModalPortal——此前自绘 scrim 绕过了 dialog 语义（role=dialog +
    // aria-modal）、focus trap（Tab 循环）与关闭时焦点归还，与其它 modal 行为不一致。
    // 首焦点（搜索框）由 ModalPortal 的「聚焦首个可聚焦元素」承担，无需 autoFocus；
    // className 传卡片样式，居中偏上的定位补偿见 command-palette.module.css 的 .palette 注释。
    <ModalPortal onClose={onClose} label="Command palette" className={styles.palette + ' modal-enter'}>
      <div className={styles.searchRow}>
        <Search size={16} strokeWidth={1.5} className={styles.searchIcon} />
        <input
          ref={inputRef}
          className={styles.searchInput}
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
    </ModalPortal>
  )
}
