import React, { useEffect, useState } from 'react'
import { History, Plus } from 'lucide-react'
import type { UiPort } from '@dogegg/bridge'
import styles from './sessions.module.css'

// 会话面板：列出历史会话 + 点击 resume。支持新建会话。
interface SessionsProps {
  port: UiPort
}

interface SessionItem {
  id: string
  updatedAt: string
  preview: string
}

export function Sessions({ port }: SessionsProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([])

  // 请求会话列表（每次切到这个面板时刷新）。
  useEffect(() => {
    port.post({ type: 'list_sessions' })
  }, [port])

  // 监听 session_list 响应——但 App 的 onMessage 已经 dispatch 到 reducer。
  // 这里用一个独立的 port.onMessage 监听 session_list 消息。
  useEffect(() => {
    return port.onMessage((msg) => {
      if (msg.type === 'session_list') {
        setSessions(msg.sessions)
      }
    })
  }, [port])

  return (
    <div className={styles.sessions + ' panel-enter'}>
      <div className={styles.header}>
        <div className={styles.title}>
          <History size={18} strokeWidth={1.5} />
          <span>Sessions</span>
        </div>
        <button className={styles.newBtn} onClick={() => port.post({ type: 'new_session' })}>
          <Plus size={14} strokeWidth={1.5} />
          <span>New</span>
        </button>
      </div>
      <div className={styles.list}>
        {sessions.length === 0 ? (
          <p className={styles.empty}>No saved sessions yet. Start a conversation to create one.</p>
        ) : (
          sessions.map((s) => (
            <button
              key={s.id}
              className={styles.sessionItem}
              onClick={() => port.post({ type: 'resume_session', id: s.id })}
            >
              <div className={styles.sessionId}>{s.id}</div>
              <div className={styles.sessionPreview}>{s.preview}</div>
              <div className={styles.sessionTime}>{s.updatedAt}</div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
