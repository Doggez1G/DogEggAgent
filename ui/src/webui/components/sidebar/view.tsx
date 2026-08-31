import React from 'react'
import { MessageSquare, FolderOpen, History, Settings, Plus, Square, Columns3, Maximize, Palette } from 'lucide-react'
import { Brand } from '../../brand'
import type { Panel, LayoutName, ThemeName } from '../../app/view-state'
import styles from './sidebar.module.css'

// 侧栏：持久导航。聊天/会话/设置 三项 + 目录切换 + 新建 + 布局切换 + 主题切换。
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

const LAYOUTS: { layout: LayoutName; icon: typeof Square; label: string }[] = [
  { layout: 'focus', icon: Square, label: 'Focus' },
  { layout: 'workspace', icon: Columns3, label: 'Workspace' },
  { layout: 'zen', icon: Maximize, label: 'Zen' },
]

const THEMES: { theme: ThemeName; label: string; color: string }[] = [
  { theme: 'catppuccin', label: 'Catppuccin', color: '#89B4FA' },
  { theme: 'ios-light', label: 'iOS Light', color: '#007AFF' },
  { theme: 'ios-dark', label: 'iOS Dark', color: '#0A84FF' },
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

        {/* 目录切换——打开 fs-browser 模态 */}
        <button
          className={`${styles.navItem} sidebar-item`}
          onClick={props.onCdClick}
          aria-label="Change directory"
          title={props.cwd}
        >
          <FolderOpen size={18} strokeWidth={1.5} />
          <span className={styles.cwdLabel}>{props.cwd.split(/[/\\]/).pop() || props.cwd}</span>
        </button>

        {/* 新建会话 */}
        <button
          className={`${styles.newBtn} sidebar-item`}
          onClick={props.onNewSession}
          disabled={props.isRunning}
          aria-label="New session"
        >
          <Plus size={16} strokeWidth={1.5} />
          <span>New Session</span>
        </button>
      </nav>

      {/* 底部：布局 + 主题切换 */}
      <div className={styles.switchers}>
        {/* 布局切换：三个图标按钮 */}
        <div className={styles.switcherGroup}>
          <span className={styles.switcherLabel}>Layout</span>
          <div className={styles.btnGroup}>
            {LAYOUTS.map(({ layout, icon: Icon, label }) => (
              <button
                key={layout}
                className={`${styles.layoutBtn} ${props.layout === layout ? styles.activeSwitch : ''} sidebar-item`}
                onClick={() => props.onLayoutChange(layout)}
                title={label}
                aria-label={`Layout: ${label}`}
              >
                <Icon size={14} strokeWidth={1.5} />
              </button>
            ))}
          </div>
        </div>

        {/* 主题切换：三个色块按钮 */}
        <div className={styles.switcherGroup}>
          <span className={styles.switcherLabel}>
            <Palette size={11} strokeWidth={1.5} />
            Theme
          </span>
          <div className={styles.btnGroup}>
            {THEMES.map((t) => (
              <button
                key={t.theme}
                className={`${styles.themeBtn} ${props.theme === t.theme ? styles.activeSwitch : ''} sidebar-item`}
                onClick={() => props.onThemeChange(t.theme)}
                title={t.label}
                aria-label={`Theme: ${t.label}`}
              >
                <span className={styles.themeSwatch} style={{ background: t.color }} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}
