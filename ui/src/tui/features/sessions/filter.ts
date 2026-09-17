// 会话搜索过滤：按标题/预览文本模糊匹配（大小写不敏感）。
export interface SessionListItem {
  id: string
  preview: string
  title?: string
  updatedAt: string
}

export function filterSessions(sessions: SessionListItem[], query: string): SessionListItem[] {
  if (!query) return sessions
  const q = query.toLowerCase()
  return sessions.filter((s) => (s.title || s.preview).toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
}

// 相对时间格式化：now/m/h/d。
export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  return `${d}天前`
}
