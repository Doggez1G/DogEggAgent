import { useCallback, useEffect, useState } from 'react'
import type { UiPort } from '@dogegg/bridge'
import type { SessionItem } from '../../app/view-state'

// 会话数据域：列表 + 已知项目集合（即使会话全删，项目保留到显式删除）。
// 独立订阅 port——只关心 session_list / session_deleted。
export function useSessions(port: UiPort): {
  sessions: SessionItem[]
  knownProjects: Set<string>
  refresh(): void
  forgetProject(projectCwd: string): void
} {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [knownProjects, setKnownProjects] = useState<Set<string>>(new Set())

  useEffect(() => {
    const off = port.onMessage((msg) => {
      // 对话结束后刷新会话列表（预览文本已随落盘更新）。
      if (msg.type === 'finished' || msg.type === 'error') { port.post({ type: 'list_sessions' }); return }
      if (msg.type === 'session_list') setSessions(msg.sessions)
      else if (msg.type === 'session_deleted') setSessions((prev) => prev.filter((s) => s.id !== msg.id))

    })
    return off
  }, [port])

  useEffect(() => {
    setKnownProjects((prev) => {
      const next = new Set(prev)
      for (const s of sessions) { if (s.cwd) next.add(s.cwd) }
      return next
    })
  }, [sessions])

  const refresh = useCallback(() => { port.post({ type: 'list_sessions' }) }, [port])

  const forgetProject = useCallback((projectCwd: string) => {
    setKnownProjects((prev) => { const next = new Set(prev); next.delete(projectCwd); return next })
  }, [])

  return { sessions, knownProjects, refresh, forgetProject }
}
