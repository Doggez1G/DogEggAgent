// 斜杠命令 → 高亮 section 映射——InputBar 和 CommandPalette 共用，消除三份重复的 onCommandFeedback if/else 链。
// App 层根据 cmd 查此映射，调用 highlightInfoSection(key) 或 setSidebarCollapsed。
export const COMMAND_FEEDBACK_MAP: Record<string, string> = {
  '/status': 'status',
  '/context': 'context',
  '/tools': 'tools',
  '/system': 'system',
  '/log': 'log',
  '/permissions': 'permissions',
  '/session': 'sessions', // sessions 高亮侧栏而非信息面板
}

// 根据 cmd 返回高亮 section key，无映射返回 null。
export function getCommandFeedback(cmd: string): string | null {
  return COMMAND_FEEDBACK_MAP[cmd] ?? null
}
