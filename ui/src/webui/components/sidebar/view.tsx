import React from 'react'
import { MessageSquare, FolderOpen, History, Settings, Plus, Square, Columns3, Maximize } from 'lucide-react'
import { Brand } from '../../brand'
import type { Panel, LayoutName, ThemeName } from '../../app/view-state'
import styles from './sidebar.module.css'

// 侧栏：持久导航。聊天/文件/会话/设置 四项 + 新建会话 + 布局切换 + 主题切换。
// 点击切换 panel（持久），与斜杠命令发送相同的 UiToAgentMessage。
interface SidebarProps {
  panel: Panel
  cwd: string
  isRunning: boolean
  layout: LayoutName
  theme: ThemeName
  onPanelChange: (panel: Panel) => void
  onNewSession: () => void
  onLayoutChange: (layout: LayoutName) => void
  onThemeChange: (theme: ThemeName) => void
  onCdClick: () => void
}

const NAV_ITEMS: { panel: Panel; icon: typeof MessageSquare; label: string }[] = [
  { panel: 'chat', icon: MessageSquare, label: 'Chat' },
  { panel: 'sessions', icon: History, label: 'Sessions' },
  { panel: 'settings', icon: Settings, label: 'Settings' },
]

const LAYOUTS: { layout: LayoutName; icon: typeof Square }[] = [
  { layout: 'focus', icon: Square },
  { layout: 'workspace', icon: Columns3 },
  { layout: 'zen', icon: Maximize },
]

const THEMES: { theme: ThemeName; label: string }[] = [
  { theme: 'catppuccin', label: 'Catppuccin' },
  { theme: 'ios-light', label: 'iOS Light' },
  { theme: 'ios-dark', label: 'iOS Dark' },
]

export function Sidebar(props: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandArea}>
        <Brand size={22} />
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map(({ panel, icon: Icon, label }) => (
          <button
            key={panel}
            className={`${styles.navItem} ${props.panel === panel ? styles.active : ''} sidebar-item`}
            onClick={() => props.onPanelChange(panel)}
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.5} />
            <span>{label}</span>
          </button>
        ))}

        {/* 文件/目录——打开 fs-browser 模态 */}
        <button
          className={`${styles.navItem} sidebar-item`}
          onClick={props.onCdClick}
          aria-label="Change directory"
          title={props.cwd}
        >
          <FolderOpen size={18} strokeWidth={1.5} />
          <span className={styles.cwdLabel}>{props.cwd.split(/[/\\]/).pop() || props.cwd}</span>
        </button>
      </nav>

      <div className={styles.actions}>
        <button
          className={`${styles.newBtn} sidebar-item`}
          onClick={props.onNewSession}
          disabled={props.isRunning}
          aria-label="New session"
        >
          <Plus size={16} strokeWidth={1.5} />
          <span>New</span>
        </button>
      </div>

      <div className={styles.switchers}>
        <div className={styles.layoutGroup}>
          {LAYOUTS.map(({ layout, icon: Icon }) => (
            <button
              key={layout}
              className={`${styles.layoutBtn} ${props.layout === layout ? styles.activeLayout : ''} sidebar-item`}
              onClick={() => props.onLayoutChange(layout)}
              aria-label={`Layout: ${layout}`}
            >
              <Icon size={14} strokeWidth={1.5} />
            </button>
          ))}
        </div>
        <select
          className={styles.themeSelect}
          value={props.theme}
          onChange={(e) => props.onThemeChange(e.target.value as ThemeName)}
          aria-label="Theme"
        >
          {THEMES.map((t) => (
            <option key={t.theme} value={t.theme}>{t.label}</option>
          ))}
        </select>
      </div>
    </aside>
  )
}
