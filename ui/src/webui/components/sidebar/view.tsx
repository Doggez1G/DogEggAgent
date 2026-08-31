import React, { useState } from 'react'
import {
  MessageSquare, FolderOpen, Settings as SettingsIcon, Plus, PanelLeftClose,
  ChevronDown, ChevronRight, Trash2, FolderPlus,
} from 'lucide-react'
import { Brand, BrandMark } from '../../brand'
import { IconButton } from '../primitives'
import { THEMES } from '../../app/view-state'
import type { ThemeName, SessionItem } from '../../app/view-state'
import styles from './sidebar.module.css'

// 侧栏：项目/会话树。
// 按 cwd 分组会话为项目。每个项目可折叠/展开。
// 项目右边 + 按钮添加新会话。底部 + Add Project 打开目录选择器。
// 点击会话 = resume_session。会话右边有删除按钮。
interface SidebarProps {
  cwd: string
  isRunning: boolean
  theme: ThemeName
  collapsed: boolean
  sessions: SessionItem[]
  activeSessionId: string
  onToggleCollapse: () => void
  onNewSession: (cwd?: string) => void
  onResumeSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onDeleteProject: (cwd: string) => void
  onAddProject: () => void
  onOpenSettings: () => void
  onThemeChange: (theme: ThemeName) => void
}

export function Sidebar(props: SidebarProps) {
  const c = props.collapsed
  // 按 cwd 分组会话。
  const projects = groupByCwd(props.sessions, props.cwd)

  return (
    <aside className={`${styles.sidebar} ${c ? styles.collapsed : ''}`}>
      {/* 顶部：品牌 + 收起按钮 */}
      <div className={styles.topBar}>
        {c ? (
          /* 收起态：仅品牌 mark（点击展开） */
          <button
            className={styles.iconBtn}
            onClick={props.onToggleCollapse}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <BrandMark size={20} />
          </button>
        ) : (
          <>
            <Brand size={20} />
            <IconButton
              icon={PanelLeftClose}
              onClick={props.onToggleCollapse}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            />
          </>
        )}
      </div>

      {/* 项目/会话树 */}
      <nav className={styles.nav}>
        {c ? (
          /* 收起态：仅添加项目按钮 */
          <IconButton
            icon={FolderPlus}
            className={styles.collapsedAdd}
            onClick={props.onAddProject}
            title="Add project"
            aria-label="Add project"
          />
        ) : (
          <>
            {projects.length === 0 ? (
              <div className={styles.emptyProjects}>
                <p>No projects yet.</p>
                <p>Add a project directory to start.</p>
              </div>
            ) : (
              projects.map((proj) => (
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
              <FolderPlus size={14} strokeWidth={1.5} />
              <span>Add Project</span>
            </button>
          </>
        )}
      </nav>

      {/* 底部：设置 + 主题 */}
      <div className={styles.bottom}>
        {c ? (
          <IconButton
            icon={SettingsIcon}
            onClick={props.onOpenSettings}
            title="Settings"
            aria-label="Settings"
          />
        ) : (
          <>
            <button className={styles.settingsBtn} onClick={props.onOpenSettings}>
              <SettingsIcon size={14} strokeWidth={1.5} />
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

// 项目树：可折叠的项目 + 其下的会话列表。
function ProjectTree(props: {
  cwd: string
  name: string
  sessions: SessionItem[]
  activeSessionId: string
  isRunning: boolean
  onNewSession: () => void
  onResumeSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onDeleteProject: () => void
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={styles.project}>
      {/* 项目头 */}
      <div className={styles.projectHeader}>
        <button
          className={styles.projectToggle}
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded
            ? <ChevronDown size={12} strokeWidth={2} />
            : <ChevronRight size={12} strokeWidth={2} />}
        </button>
        <FolderOpen size={14} strokeWidth={1.5} className={styles.projectIcon} />
        <span className={styles.projectName} title={props.cwd}>{props.name}</span>
        <button
          className={styles.projectAdd}
          onClick={props.onNewSession}
          disabled={props.isRunning}
          title="New session"
          aria-label="New session"
        >
          <Plus size={12} strokeWidth={2} />
        </button>
        <button
          className={styles.projectDel}
          onClick={props.onDeleteProject}
          title="Delete project"
          aria-label="Delete project"
        >
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </div>

      {/* 会话列表 */}
      {expanded && (
        <div className={styles.sessionList}>
          {props.sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles.sessionItem} ${props.activeSessionId === s.id ? styles.sessionActive : ''}`}
              onClick={() => props.onResumeSession(s.id)}
            >
              <MessageSquare size={12} strokeWidth={1.5} className={styles.sessionIcon} />
              <span className={styles.sessionPreview}>{s.preview || s.id}</span>
              <button
                className={styles.sessionDel}
                onClick={(e) => { e.stopPropagation(); props.onDeleteSession(s.id) }}
                title="Delete session"
                aria-label="Delete session"
              >
                <Trash2 size={11} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          {props.sessions.length === 0 && (
            <p className={styles.noSessions}>No sessions</p>
          )}
        </div>
      )}
    </div>
  )
}

// 按 cwd 分组会话为项目列表。当前 cwd 始终显示（即使没有会话）。
function groupByCwd(sessions: SessionItem[], currentCwd: string): { cwd: string; name: string; sessions: SessionItem[] }[] {
  const map = new Map<string, SessionItem[]>()
  // 确保 currentCwd 在列表中（空项目也显示）。
  if (currentCwd) map.set(currentCwd, [])
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
