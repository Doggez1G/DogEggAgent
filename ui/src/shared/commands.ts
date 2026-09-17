import type { UiToAgentMessage } from '@dogegg/bridge'

// 全部斜杠命令（按字母序），带简短描述供联想提示展示。
export const COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/cd', desc: '切换工作目录' },
  { cmd: '/clear', desc: '清空历史' },
  { cmd: '/compact', desc: '手动压缩上下文' },
  { cmd: '/config', desc: '编辑配置' },
  { cmd: '/context', desc: '查看上下文占用' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/log', desc: '查看调试日志' },
  { cmd: '/model', desc: '快速切换模型' },
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/permissions', desc: '查看/撤销会话权限授权' },
  { cmd: '/rename', desc: '重命名当前会话' },
  { cmd: '/quit', desc: '退出' },
  { cmd: '/session', desc: '切换会话' },
  { cmd: '/status', desc: '状态一览' },
  { cmd: '/system', desc: '查看 system prompt' },
  { cmd: '/tools', desc: '列出工具' },
]

// 前缀匹配：输入以 / 开头时，返回所有以当前输入为前缀的命令。
// 输入 / → 全部命令；输入 /s → /session, /status, /system；输入 /se → /session。
// 输入本身已完整匹配某命令时不再联想（用户已打完）。
export function matchCommands(input: string): { cmd: string; desc: string }[] {
  if (!input.startsWith('/')) return []
  const exact = COMMANDS.find((c) => c.cmd === input)
  if (exact) return []
  return COMMANDS.filter((c) => c.cmd.startsWith(input))
}

// 斜杠命令解析结果：null = 非命令（普通消息）；UiToAgentMessage = 对应的后端消息。
// /help 是 UI 本地渲染（不发后端消息），返回特殊标记。
export type CommandResult =
  | { kind: 'message'; msg: UiToAgentMessage }
  | { kind: 'help' }
  | { kind: 'user'; text: string }

// 解析输入框文本 → 命令消息。★ 可单测。
// /model 和 /config 都先请求 config（后端回 config_state），由 App 根据 intent 决定打开哪个 overlay/面板。
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
    case '/cd': {
      // /cd <path>——参数为路径（支持空格路径：取 /cd 之后的全部文本）。
      const path = trimmed.slice('/cd'.length).trim()
      if (!path) return { kind: 'help' }
      return { kind: 'message', msg: { type: 'set_cwd', path } }
    }
    case '/context': return { kind: 'message', msg: { type: 'context_request' } }
    case '/tools': return { kind: 'message', msg: { type: 'tools_request' } }
    case '/system': return { kind: 'message', msg: { type: 'system_request' } }
    case '/status': return { kind: 'message', msg: { type: 'status_request' } }
    case '/log': return { kind: 'message', msg: { type: 'log_request' } }
    case '/permissions': return { kind: 'message', msg: { type: 'permissions_request' } }
    case '/rename': {
      // /rename <名称>——参数为标题（支持空格：取 /rename 之后的全部文本）。
      const title = trimmed.slice('/rename'.length).trim()
      if (!title) return { kind: 'help' }
      return { kind: 'message', msg: { type: 'rename_session', title } }
    }
    case '/quit': return { kind: 'message', msg: { type: 'quit' } }
    case '/help': return { kind: 'help' }
    default: return { kind: 'help' } // 未知命令也显示帮助
  }
}
