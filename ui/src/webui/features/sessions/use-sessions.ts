import { useCallback, useEffect, useState } from 'react'
import type { UiPort } from '@dogegg/bridge'
import type { SessionItem } from '../../view-state'

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

  const refresh = useCallback(() => { port.post({ type: 'list_sessions' }) }, [port])

  useEffect(() => {
    // 挂载即拉取会话列表——侧栏的历史会话与项目（与门面启动时的 config/status 请求同批）。
    refresh()
    const off = port.onMessage((msg) => {
      // 会话切换/新建：后端已保存会话，刷新列表让侧栏即时显示（含恢复后的当前会话）。
      if (msg.type === 'session_ready') refresh()
      // 对话结束后刷新会话列表（预览文本已随落盘更新）。
      else if (msg.type === 'finished' || msg.type === 'error') { port.post({ type: 'list_sessions' }); return }
      if (msg.type === 'session_list') setSessions(msg.sessions)
      else if (msg.type === 'session_deleted') setSessions((prev) => prev.filter((s) => s.id !== msg.id))
    })
    return off
  }, [port, refresh])

  useEffect(() => {
    setKnownProjects((prev) => {
      const next = new Set(prev)
      for (const s of sessions) { if (s.cwd) next.add(s.cwd) }
      return next
    })
  }, [sessions])

  const forgetProject = useCallback((projectCwd: string) => {
    setKnownProjects((prev) => { const next = new Set(prev); next.delete(projectCwd); return next })
  }, [])

  return { sessions, knownProjects, refresh, forgetProject }
}
