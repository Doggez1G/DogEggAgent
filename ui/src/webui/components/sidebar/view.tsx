import React from 'react'
import { MessageSquare, FolderOpen, History, Settings, Plus, PanelLeftClose, PanelLeft, Palette } from 'lucide-react'
import { Brand } from '../../brand'
import type { Panel, ThemeName } from '../../app/view-state'
import styles from './sidebar.module.css'

// 侧栏：可收起的导航栏。展开 240px（图标+文字），收起 56px（仅图标）。
// 导航：Chat / Sessions / Settings + 目录切换 + 新建会话。
// 底部：主题色块按钮（3 个小圆点切换主题）。
interface SidebarProps {
  panel: Panel
  cwd: string
  isRunning: boolean
  theme: ThemeName
  collapsed: boolean
  onToggleCollapse: () => void
  onPanelChange: (panel: Panel) => void
  onNewSession: () => void
  onThemeChange: (theme: ThemeName) => void
  onCdClick: () => void
}

const NAV_ITEMS: { panel: Panel; icon: typeof MessageSquare; label: string }[] = [
  { panel: 'chat', icon: MessageSquare, label: 'Chat' },
  { panel: 'sessions', icon: History, label: 'Sessions' },
  { panel: 'settings', icon: Settings, label: 'Settings' },
]

const THEMES: { theme: ThemeName; label: string; color: string }[] = [
  { theme: 'catppuccin', label: 'Catppuccin', color: '#89B4FA' },
  { theme: 'ios-light', label: 'iOS Light', color: '#007AFF' },
  { theme: 'ios-dark', label: 'iOS Dark', color: '#0A84FF' },
]

export function Sidebar(props: SidebarProps) {
  const c = props.collapsed
  return (
    <aside className={`${styles.sidebar} ${c ? styles.collapsed : ''}`}>
      {/* 顶部：品牌 + 收起按钮 */}
      <div className={styles.topBar}>
        {c ? (
          <button className={styles.collapseBtn} onClick={props.onToggleCollapse} title="Expand sidebar" aria-label="Expand sidebar">
            <PanelLeft size={18} strokeWidth={1.5} />
          </button>
        ) : (
          <>
            <Brand size={20} />
            <button className={styles.collapseBtn} onClick={props.onToggleCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">
              <PanelLeftClose size={18} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      {/* 导航 */}
      <nav className={styles.nav}>
        {NAV_ITEMS.map(({ panel, icon: Icon, label }) => (
          <button
            key={panel}
            className={`${styles.navItem} ${props.panel === panel ? styles.active : ''} sidebar-item`}
            onClick={() => props.onPanelChange(panel)}
            title={c ? label : undefined}
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.5} className={styles.navIcon} />
            {!c && <span className={styles.navLabel}>{label}</span>}
          </button>
        ))}

        {/* 目录切换 */}
        <button
          className={`${styles.navItem} sidebar-item`}
          onClick={props.onCdClick}
          title={c ? `Directory: ${props.cwd}` : props.cwd}
          aria-label="Change directory"
        >
          <FolderOpen size={18} strokeWidth={1.5} className={styles.navIcon} />
          {!c && <span className={styles.cwdLabel}>{props.cwd.split(/[/\\]/).pop() || props.cwd}</span>}
        </button>

        {/* 新建会话 */}
        <button
          className={`${styles.newBtn} sidebar-item`}
          onClick={props.onNewSession}
          disabled={props.isRunning}
          title={c ? 'New session' : undefined}
          aria-label="New session"
        >
          <Plus size={16} strokeWidth={1.5} />
          {!c && <span>New Session</span>}
        </button>
      </nav>

      {/* 底部：主题色块 */}
      <div className={styles.bottom}>
        {c ? (
          <button className={styles.themeToggleCollapsed} title="Theme" aria-label="Theme">
            <Palette size={16} strokeWidth={1.5} />
          </button>
        ) : (
          <div className={styles.themeRow}>
            <Palette size={12} strokeWidth={1.5} className={styles.themeLabel} />
            {THEMES.map((t) => (
              <button
                key={t.theme}
                className={`${styles.themeBtn} ${props.theme === t.theme ? styles.themeActive : ''} sidebar-item`}
                onClick={() => props.onThemeChange(t.theme)}
                title={t.label}
                aria-label={`Theme: ${t.label}`}
              >
                <span className={styles.themeSwatch} style={{ background: t.color }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
