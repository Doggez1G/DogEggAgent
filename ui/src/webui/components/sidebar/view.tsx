import React, { useState } from 'react'
import {
  MessageSquare, FolderOpen, Settings as SettingsIcon, Plus, PanelLeftClose,
  ChevronDown, ChevronRight, Trash2, FolderPlus, Search,
} from 'lucide-react'
import { Brand, BrandMark } from '../../brand'
import { IconButton } from '../primitives'
import { THEMES } from '../../app/view-state'
import type { ThemeName, SessionItem } from '../../app/view-state'
import styles from './sidebar.module.css'

// 侧栏：品牌 + 搜索框 + 项目/会话树 + 设置 + 主题切换。
interface SidebarProps {
  cwd: string
  isRunning: boolean
  theme: ThemeName
  collapsed: boolean
  sessions: SessionItem[]
  knownProjects: Set<string>
  activeSessionId: string
  highlightSection?: string | null
  onToggleCollapse: () => void
  onNewSession: (cwd?: string) => void
  onResumeSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onDeleteProject: (cwd: string) => void
  onAddProject: () => void
  onOpenSettings: () => void
  onThemeChange: (theme: ThemeName) => void
}

// 相对时间格式化。
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export function Sidebar(props: SidebarProps) {
  const c = props.collapsed
  const [search, setSearch] = useState('')
  const projects = groupByCwd(props.sessions, props.knownProjects)

  // 搜索过滤。
  const filteredProjects = search
    ? projects.map(p => ({
      ...p,
      sessions: p.sessions.filter(s => s.preview.toLowerCase().includes(search.toLowerCase())),
    })).filter(p => p.sessions.length > 0)
    : projects

  return (
    <aside className={`${styles.sidebar} ${c ? styles.collapsed : ''}`}>
      <div className={styles.topBar}>
        {c ? (
          <button className={styles.iconBtn} onClick={props.onToggleCollapse} title="Expand sidebar" aria-label="Expand sidebar">
            <BrandMark size={20} />
          </button>
        ) : (
          <>
            <Brand size={20} />
            <button className={styles.iconBtn} onClick={props.onToggleCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">
              <PanelLeftClose size={16} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      {!c && (
        <div className={styles.searchWrap}>
          <Search size={12} strokeWidth={1.5} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      <nav className={`${styles.nav} ${props.highlightSection === 'sessions' ? styles.navHighlight : ''}`}>
        {c ? (
          <button className={styles.iconBtn + ' ' + styles.collapsedAdd} onClick={props.onAddProject} title="Add project" aria-label="Add project">
            <FolderPlus size={16} strokeWidth={1.5} />
          </button>
        ) : (
          <>
            <div className={styles.navLabel}>Projects</div>
            {filteredProjects.length === 0 ? (
              <div className={styles.emptyProjects}>
                <p>{search ? 'No matches.' : 'No projects yet.'}</p>
                {!search && <p>Add a project directory to start.</p>}
              </div>
            ) : (
              filteredProjects.map((proj) => (
                <ProjectTree
                  key={proj.cwd}
                  cwd={proj.cwd}
                  name={proj.name}
                  sessions={proj.sessions}
                  activeSessionId={props.activeSessionId}
                  isRunning={props.isRunning}
                  onNewSession={() => props.onNewSession(proj.cwd)}
                  onResumeSession={props.onResumeSession}
                  onDeleteSession={props.onDeleteSession}
                  onDeleteProject={() => props.onDeleteProject(proj.cwd)}
                />
              ))
            )}
            <button className={styles.addProjectBtn} onClick={props.onAddProject}>
              <FolderPlus size={13} strokeWidth={1.5} />
              <span>Add Project</span>
            </button>
          </>
        )}
      </nav>

      <div className={styles.bottom}>
        {c ? (
          <button className={styles.iconBtn} onClick={props.onOpenSettings} title="Settings" aria-label="Settings">
            <SettingsIcon size={16} strokeWidth={1.5} />
          </button>
        ) : (
          <>
            <button className={styles.settingsBtn} onClick={props.onOpenSettings}>
              <SettingsIcon size={13} strokeWidth={1.5} />
              <span>Settings</span>
            </button>
            <div className={styles.themeRow}>
              {THEMES.map((t) => (
                <button
                  key={t.theme}
                  className={`${styles.themeBtn} ${props.theme === t.theme ? styles.themeActive : ''}`}
                  onClick={() => props.onThemeChange(t.theme)}
                  title={t.label}
                  aria-label={`Theme: ${t.label}`}
                >
                  <span className={styles.themeSwatch} style={{ background: t.color }} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

// 项目树：折叠头 + 会话列表。
function ProjectTree(props: {
  cwd: string; name: string; sessions: SessionItem[]
  activeSessionId: string; isRunning: boolean
  onNewSession: () => void; onResumeSession: (id: string) => void
  onDeleteSession: (id: string) => void; onDeleteProject: () => void
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={styles.project}>
      <div className={styles.projectHeader}>
        <button className={styles.projectToggle} onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </button>
        <FolderOpen size={13} strokeWidth={1.5} className={styles.projectIcon} />
        <span className={styles.projectName} title={props.cwd}>{props.name}</span>
        <span className={styles.projectCount}>{props.sessions.length}</span>
        <button className={styles.projectAdd} onClick={props.onNewSession} disabled={props.isRunning} title="New session" aria-label="New session">
          <Plus size={11} strokeWidth={2} />
        </button>
        <button className={styles.projectDel} onClick={props.onDeleteProject} title="Delete project" aria-label="Delete project">
          <Trash2 size={11} strokeWidth={1.5} />
        </button>
      </div>

      {expanded && (
        <div className={styles.sessionList}>
          {props.sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles.sessionItem} ${props.activeSessionId === s.id ? styles.sessionActive : ''}`}
              onClick={() => props.onResumeSession(s.id)}
            >
              <span className={styles.sessionDot} />
              <span className={styles.sessionPreview}>{s.preview || 'New Session'}</span>
              <span className={styles.sessionTime}>{relTime(s.updatedAt)}</span>
              <button className={styles.sessionDel} onClick={(e) => { e.stopPropagation(); props.onDeleteSession(s.id) }} title="Delete session" aria-label="Delete session">
                <Trash2 size={10} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          {props.sessions.length === 0 && <p className={styles.noSessions}>No sessions</p>}
        </div>
      )}
    </div>
  )
}

// 按工作目录分组会话。已知项目（即使 0 会话）仍保留显示，直到显式删除。
function groupByCwd(sessions: SessionItem[], knownProjects: Set<string>): { cwd: string; name: string; sessions: SessionItem[] }[] {
  const map = new Map<string, SessionItem[]>()
  // 先注入已知项目——保证即使 0 会话也显示（带删除按钮）。
  for (const cwd of knownProjects) map.set(cwd, [])
  for (const s of sessions) {
    const key = s.cwd || '(unknown)'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return Array.from(map.entries()).map(([cwd, sess]) => ({
    cwd,
    name: cwd.split(/[/\\]/).pop() || cwd,
    sessions: sess.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }))
}
