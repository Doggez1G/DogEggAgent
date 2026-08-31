import React, { useEffect, useState } from 'react'
import { History, Plus, ArrowLeft, Clock } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import styles from './sessions.module.css'

// 会话面板：面板头（返回 + 标题 + 新建）+ 会话列表。
// 每条会话卡片显示 ID、预览、时间，点击 resume。
interface SessionsProps {
  port: UiPort
  onBack: () => void
}

interface SessionItem {
  id: string
  updatedAt: string
  preview: string
}

export function Sessions({ port, onBack }: SessionsProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([])

  // 请求会话列表（每次切到这个面板时刷新）。
  useEffect(() => {
    port.post({ type: 'list_sessions' })
  }, [port])

  // 监听 session_list 响应。
  useEffect(() => {
    return port.onMessage((msg) => {
      if (msg.type === 'session_list') {
        setSessions(msg.sessions)
      }
    })
  }, [port])

  return (
    <div className={styles.sessions}>
      {/* 面板头 */}
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={onBack} aria-label="Back to chat">
          <ArrowLeft size={18} strokeWidth={1.5} />
        </button>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <History size={18} strokeWidth={1.5} className={styles.titleIcon} />
            <span className={styles.title}>Sessions</span>
          </div>
          <span className={styles.subtitle}>{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </div>
        <button className={styles.newBtn} onClick={() => port.post({ type: 'new_session' })}>
          <Plus size={14} strokeWidth={1.5} />
          <span>New</span>
        </button>
      </header>

      {/* 会话列表 */}
      <div className={styles.list}>
        {sessions.length === 0 ? (
          <div className={styles.emptyState}>
            <History size={32} strokeWidth={1} className={styles.emptyIcon} />
            <p className={styles.emptyTitle}>No Sessions Yet</p>
            <p className={styles.emptyDesc}>Start a conversation to create your first session. Sessions are saved automatically.</p>
          </div>
        ) : (
          sessions.map((s) => (
            <button
              key={s.id}
              className={styles.sessionCard}
              onClick={() => port.post({ type: 'resume_session', id: s.id })}
            >
              <div className={styles.sessionTop}>
                <code className={styles.sessionId}>{s.id}</code>
                <span className={styles.sessionTime}>
                  <Clock size={11} strokeWidth={1.5} />
                  {formatTime(s.updatedAt)}
                </span>
              </div>
              <p className={styles.sessionPreview}>{s.preview}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// 简化时间显示。
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
    return d.toLocaleDateString()
  } catch {
    return iso
  }
}
