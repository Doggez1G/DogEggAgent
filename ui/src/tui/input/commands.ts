import type { UiToAgentMessage } from '@dogegg/bridge'

// 斜杠命令解析结果：null = 非命令（普通消息）；UiToAgentMessage = 对应的后端消息。
// /help 是 UI 本地渲染（不发后端消息），返回特殊标记。
export type CommandResult =
  | { kind: 'message'; msg: UiToAgentMessage }
  | { kind: 'help' }
  | { kind: 'user'; text: string }

// 解析输入框文本 → 命令消息。★ 可单测。
// /model 和 /config 都先请求 config（后端回 config_state），由 App 根据 intent 决定打开哪个 overlay。
export function parseCommand(text: string): CommandResult {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'user', text: '' }
  if (!trimmed.startsWith('/')) return { kind: 'user', text: trimmed }

  const cmd = trimmed.split(/\s+/)[0]!
  switch (cmd) {
    case '/new': return { kind: 'message', msg: { type: 'new_session' } }
    case '/session': return { kind: 'message', msg: { type: 'list_sessions' } }
    case '/model': return { kind: 'message', msg: { type: 'config_request' } } // intent 由 App 设为 'model'
    case '/config': return { kind: 'message', msg: { type: 'config_request' } } // intent 由 App 设为 'config'
    case '/clear': return { kind: 'message', msg: { type: 'clear_history' } }
    case '/compact': return { kind: 'message', msg: { type: 'compact_request' } }
    case '/context': return { kind: 'message', msg: { type: 'context_request' } }
    case '/tools': return { kind: 'message', msg: { type: 'tools_request' } }
    case '/system': return { kind: 'message', msg: { type: 'system_request' } }
    case '/status': return { kind: 'message', msg: { type: 'status_request' } }
    case '/log': return { kind: 'message', msg: { type: 'log_request' } }
    case '/quit': return { kind: 'message', msg: { type: 'quit' } }
    case '/help': return { kind: 'help' }
    default: return { kind: 'help' } // 未知命令也显示帮助
  }
}
