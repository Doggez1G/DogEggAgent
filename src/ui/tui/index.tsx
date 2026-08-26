import React, { useEffect, useReducer, useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import type { Agent } from '../../agent/index'
import type { AgentToUiMessage } from '../../events/agent-to-ui'
import { MessageBlock, StatusBar, type BlockColor } from './components'

interface Block {
  icon: string
  role: string
  color: BlockColor
  text: string
}

interface State {
  blocks: Block[]
  status: string
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
}

// 本地 UI 动作（不来自后端）。
type Action =
  | AgentToUiMessage
  | { type: 'local_user'; text: string }
  | { type: 'local_help' }

const ICON = { user: '🥚', assistant: '🐶', tool: '🐾', thinking: '🐣' } as const
const COLOR = { user: 'blue', assistant: 'green', tool: 'cyan', thinking: 'yellow' } as const

const HELP = '/new /session /model /config /clear /compact /context /tools /system /status /log /help /quit'

function flush(state: State): State {
  if (!state.partial) return state
  const isThinking = state.partial.kind === 'thinking'
  return {
    ...state,
    partial: null,
    blocks: [
      ...state.blocks,
      { icon: isThinking ? ICON.thinking : ICON.assistant, role: isThinking ? '思考' : '助手', color: isThinking ? COLOR.thinking : COLOR.assistant, text: state.partial.text },
    ],
  }
}

function infoBlock(state: State, role: string, text: string): State {
  return { ...state, blocks: [...state.blocks, { icon: '🥚', role, color: 'gray', text }] }
}

function reducer(state: State, msg: Action): State {
  switch (msg.type) {
    case 'local_user':
      return { ...state, blocks: [...state.blocks, { icon: ICON.user, role: '你', color: COLOR.user, text: msg.text }] }
    case 'local_help':
      return infoBlock(state, '帮助', HELP)
    case 'text_delta':
      return { ...state, status: 'responding', partial: { kind: 'assistant', text: (state.partial?.text ?? '') + msg.delta } }
    case 'thought_delta':
      return { ...state, status: 'thinking', partial: { kind: 'thinking', text: (state.partial?.text ?? '') + msg.delta } }
    case 'message':
      return msg.role === 'assistant' ? flush(state) : state
    case 'tool_start': {
      const flushed = flush(state)
      return { ...flushed, status: 'executing', blocks: [...flushed.blocks, { icon: ICON.tool, role: '工具', color: COLOR.tool, text: `${msg.name} ${JSON.stringify(msg.input)}` }] }
    }
    case 'tool_end': {
      const blocks = [...state.blocks]
      const last = blocks[blocks.length - 1]
      if (last && last.icon === ICON.tool) {
        blocks[blocks.length - 1] = { ...last, text: last.text + (msg.error ? `\n✕ ${msg.error}` : `\n✓ 完成`) }
      }
      return { ...state, blocks }
    }
    case 'state':
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished' }
    case 'error':
      return { ...state, status: 'error', blocks: [...state.blocks, { icon: '🐶', role: '错误', color: 'red', text: msg.error.message }] }
    case 'session_ready':
      return { ...state, blocks: msg.messages.map((m) => ({ icon: ICON[m.role] ?? '🥚', role: m.role, color: COLOR[m.role] ?? 'gray', text: m.content ?? '' })) }
    case 'session_list':
      return infoBlock(state, '会话', msg.sessions.map((s) => `${s.id}  ${s.preview}`).join('\n'))
    case 'tools_list':
      return infoBlock(state, '工具', msg.tools.map((t) => `${t.name} — ${t.description}`).join('\n'))
    case 'status_state':
      return infoBlock(state, '状态', `session=${msg.sessionId}  provider=${msg.provider}  model=${msg.model}\ncwd=${msg.cwd}`)
    case 'context_state':
      return infoBlock(state, '上下文', `${msg.estimatedTokens} / ${msg.windowTokens} tokens`)
    case 'system_state':
      return infoBlock(state, 'system prompt', `${msg.path}\n${msg.content}`)
    case 'compaction':
      return infoBlock(state, '压缩', `${msg.before_tokens} → ${msg.after_tokens} tokens`)
    case 'history_cleared':
      return { ...state, blocks: [] }
    default:
      return state
  }
}

export function App({ agent }: { agent: Agent }) {
  const [state, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: null })
  const [input, setInput] = useState('')

  useEffect(() => {
    return agent.on((msg) => {
      dispatch(msg)
      // v1 简化：无交互选择器，权限请求先自动「允许一次」；完整三选项 UI 后续补。
      if (msg.type === 'permission_request') {
        agent.send({ type: 'permission_decision', id: msg.id, decision: 'allow_once' })
      }
    })
  }, [agent])

  const handleSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const cmd = text.startsWith('/') ? text.split(/\s+/)[0]! : null
    if (cmd) {
      switch (cmd) {
        case '/new': agent.send({ type: 'new_session' }); break
        case '/session': agent.send({ type: 'list_sessions' }); break
        case '/model':
        case '/config': agent.send({ type: 'config_request' }); break
        case '/clear': agent.send({ type: 'clear_history' }); break
        case '/compact': agent.send({ type: 'compact_request' }); break
        case '/context': agent.send({ type: 'context_request' }); break
        case '/tools': agent.send({ type: 'tools_request' }); break
        case '/system': agent.send({ type: 'system_request' }); break
        case '/status': agent.send({ type: 'status_request' }); break
        case '/log': agent.send({ type: 'log_request' }); break
        case '/quit': agent.send({ type: 'quit' }); break
        case '/help': dispatch({ type: 'local_help' }); break
        default: dispatch({ type: 'local_help' })
      }
    } else {
      dispatch({ type: 'local_user', text })
      agent.send({ type: 'submit', text })
    }
    setInput('')
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" flexGrow={1}>
        {state.blocks.map((b, i) => (
          <MessageBlock key={i} icon={b.icon} role={b.role} color={b.color}>
            <Text>{b.text}</Text>
          </MessageBlock>
        ))}
        {state.partial ? (
          <MessageBlock icon={ICON.assistant} role="助手（流式）" color={COLOR.assistant}>
            <Text>{state.partial.text}</Text>
          </MessageBlock>
        ) : null}
      </Box>
      <StatusBar state={state.status} />
      <Box>
        <Text color="blue">› </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}