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

// /session 选择器的 cwd 过滤（Claude 式——每个工作目录独立一份会话列表）。
// 路径归一化：统一小写 + 正斜杠，兼容 Windows 反斜杠与大小写不敏感文件系统。
//
// 立法（2026-09-24）：cwd 为空/缺失的会话视为「始终可见」——ADR-0006（会话 cwd 持久化）
// 之前的旧存档没有 cwd 字段，若按「归一化后与当前 cwd 相等」过滤，它们与任何目录都不等，
// 将永远不可见。空 cwd 无法判断归属，宁可多显示（归属不明 ≠ 不存在）。
// T = 会话条目形态（session_list 消息的 sessions 条目），返回同一批条目的子集。
export function filterSessionsByCwd<T extends { cwd?: string }>(sessions: T[], cwd: string): T[] {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const cur = normalize(cwd)
  return sessions.filter((s) => !s.cwd || normalize(s.cwd) === cur)
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
