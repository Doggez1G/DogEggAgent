import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { Agent } from '../../agent/index'
import type { AgentToUiMessage } from '../../events/agent-to-ui'
import type { PermissionDecision } from '../../events/types'
import type { Config } from '../../config/schema'
import { MessageBlock, StatusBar, ListPicker, type BlockColor } from './components'
import { renderMarkdown } from '../../common/utils/markdown'
import { buildEntries, entryLabel, parentPath, type ConfigPath, type TreeCtx } from './config-tree'

interface Block {
  icon: string
  role: string
  color: BlockColor
  text: string
}

interface ChatState {
  blocks: Block[]
  status: string
  partial: { kind: 'assistant' | 'thinking'; text: string } | null
}

type Action =
  | AgentToUiMessage
  | { type: 'local_user'; text: string }
  | { type: 'local_help' }

type MenuItem = { label: string; onSelect: () => void }

// UI 自己的视图态（叠加在后端状态机之上，二者正交）。
type View =
  | { kind: 'none' }
  | { kind: 'permission'; id: string; tool: string; input: unknown; cursor: number }
  | { kind: 'menu'; title: string; items: MenuItem[]; cursor: number }
  | { kind: 'prompt'; title: string; value: string; onSubmit: (v: string) => void }
  | { kind: 'config'; path: ConfigPath; cursor: number; preview: boolean | null }

const ICON = { user: '🥚', assistant: '🐶', tool: '🐾', thinking: '🐣' } as const
const COLOR: Record<keyof typeof ICON, BlockColor> = { user: 'blue', assistant: 'green', tool: 'cyan', thinking: 'yellow' }

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']
const HELP = '/new /session /model /config /clear /compact /context /tools /system /status /log /help /quit'

function flush(state: ChatState): ChatState {
  if (!state.partial) return state
  const isThinking = state.partial.kind === 'thinking'
  return {
    ...state,
    partial: null,
    blocks: [...state.blocks, { icon: isThinking ? ICON.thinking : ICON.assistant, role: isThinking ? '思考' : '助手', color: isThinking ? COLOR.thinking : COLOR.assistant, text: state.partial.text }],
  }
}

function infoBlock(state: ChatState, role: string, text: string): ChatState {
  return { ...state, blocks: [...state.blocks, { icon: '🥚', role, color: 'gray', text }] }
}

function reducer(state: ChatState, msg: Action): ChatState {
  switch (msg.type) {
    case 'local_user':
      return { ...state, blocks: [...state.blocks, { icon: ICON.user, role: '你', color: COLOR.user, text: msg.text }] }
    case 'local_help':
      return infoBlock(state, '帮助', HELP)
    case 'text_delta': {
      // 推理模型的思考与回答是两种块：轮到 text_delta 时，若有未落盘的思考块，先 flush 再开新回答块。
      const base = state.partial?.kind === 'thinking' ? flush(state) : state
      return { ...base, status: 'responding', partial: { kind: 'assistant', text: (base.partial?.text ?? '') + msg.delta } }
    }
    case 'thought_delta': {
      const base = state.partial?.kind === 'assistant' ? flush(state) : state
      return { ...base, status: 'thinking', partial: { kind: 'thinking', text: (base.partial?.text ?? '') + msg.delta } }
    }
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
        blocks[blocks.length - 1] = { ...last, text: last.text + (msg.error ? `\n✕ ${msg.error}` : `\n✓ 完成（${msg.output.slice(0, 120)}${msg.output.length > 120 ? '…' : ''}）`) }
      }
      return { ...state, blocks }
    }
    case 'state':
      return { ...state, status: msg.to }
    case 'finished':
      return { ...flush(state), status: 'finished' }
    case 'error':
      return { ...state, status: 'error', blocks: [...state.blocks, { icon: '🐶', role: '错误', color: 'red', text: msg.error.message }] }
    case 'notice':
      return { ...state, blocks: [...state.blocks, { icon: '🥚', role: '提示', color: 'yellow', text: msg.text }] }
    case 'session_ready':
      return { ...state, status: 'idle', blocks: msg.messages.map((m) => ({ icon: ICON[m.role] ?? '🥚', role: m.role, color: COLOR[m.role] ?? 'gray', text: (m as { content?: string }).content ?? '' })) }
    case 'tools_list':
      return infoBlock(state, '工具', msg.tools.map((t) => `${t.name} — ${t.description}`).join('\n'))
    case 'status_state':
      return infoBlock(state, '状态', `session=${msg.sessionId}  provider=${msg.provider}  model=${msg.model}\ncwd=${msg.cwd}  state=${msg.state}`)
    case 'context_state':
      return infoBlock(state, '上下文', `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`)
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
  const [chat, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: null })
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const [input, setInput] = useState('')
  const [configSnapshot, setConfigSnapshot] = useState<Config | null>(null)
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  const configIntent = useRef<'model' | 'config' | null>(null)
  const suppressEnterRef = useRef(false)

  const setView = useCallback((v: View) => {
    viewRef.current = v
    setViewState(v)
  }, [])

  const updateConfig = useCallback((c: Config) => {
    configRef.current = c
    setConfigSnapshot(c)
  }, [])

  const openMenu = useCallback((title: string, items: MenuItem[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])

  // 配置树的三类变更入口，统一翻译成 config_set/add/remove 消息。
  const treeCtx: TreeCtx = {
    set: (path, value) => agent.send({ type: 'config_set', path, value }),
    add: (path, value) => agent.send({ type: 'config_add', path, value }),
    remove: (path, index, providerIndex) => agent.send({ type: 'config_remove', path, index, providerIndex }),
  }

  // 模型选择（/model 快捷）：provider → model 两级。
  const openModelPicker = useCallback((config: Config) => {
    openMenu('选择 provider', config.providers.map((p) => ({
      label: p.name || '（未命名）',
      onSelect: () =>
        openMenu(`选择模型（${p.name || '未命名'}）`, p.models.map((m) => ({
          label: `${m.name || '（未命名）'}${m.reasoning ? ' · reasoning' : ''}`,
          onSelect: () => {
            agent.send({ type: 'config_set', path: 'defaultProvider', value: p.name })
            agent.send({ type: 'config_set', path: 'defaultModel', value: m.name })
            setView({ kind: 'none' })
          },
        }))),
    })))
  }, [agent, openMenu, setView])

  // 打开配置树：先把 config 快照进本地，再进入根层。
  const openConfigTree = useCallback((config: Config) => {
    updateConfig(config)
    setView({ kind: 'config', path: { kind: 'root' }, cursor: 0, preview: null })
  }, [updateConfig, setView])

  useEffect(() => {
    return agent.on((msg) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, cursor: 0 })
      } else if (msg.type === 'session_list') {
        openMenu('选择会话（回车切换）', msg.sessions.map((s) => ({
          label: `${s.id}  ${s.preview}`,
          onSelect: () => { agent.send({ type: 'resume_session', id: s.id }); setView({ kind: 'none' }) },
        })))
      } else if (msg.type === 'config_state') {
        if (configIntent.current === 'model') openModelPicker(msg.config)
        else if (configIntent.current === 'config') openConfigTree(msg.config)
      } else if (msg.type === 'config_updated') {
        // 配置变更后刷新快照，配置树会按当前 path 重新渲染。
        updateConfig(msg.config)
      }
    })
  }, [agent, openMenu, openModelPicker, openConfigTree, updateConfig, setView])

  useInput((inputChar, key) => {
    // 命令提交的那次回车会被 TextInput 与 useInput 各处理一次：这里吞掉紧随命令后的第一次回车，
    // 避免它在刚打开的配置树/菜单里误触发首个字段或首项。
    if (key.return && suppressEnterRef.current) {
      suppressEnterRef.current = false
      return
    }
    const v = viewRef.current
    if (v.kind === 'permission') {
      if (key.upArrow) setView({ ...v, cursor: (v.cursor + DECISIONS.length - 1) % DECISIONS.length })
      else if (key.downArrow) setView({ ...v, cursor: (v.cursor + 1) % DECISIONS.length })
      else if (key.return) { agent.send({ type: 'permission_decision', id: v.id, decision: DECISIONS[v.cursor]! }); setView({ kind: 'none' }) }
      else if (key.escape) { agent.send({ type: 'permission_decision', id: v.id, decision: 'reject' }); setView({ kind: 'none' }) }
    } else if (v.kind === 'menu') {
      if (key.upArrow) setView({ ...v, cursor: (v.cursor + v.items.length - 1) % Math.max(1, v.items.length) })
      else if (key.downArrow) setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, v.items.length) })
      else if (key.return) { v.items[v.cursor]?.onSelect() }
      else if (key.escape) setView({ kind: 'none' })
    } else if (v.kind === 'config') {
      const cfg = configRef.current
      const entries = cfg ? buildEntries(cfg, v.path, treeCtx) : []
      const entry = entries[v.cursor]
      if (key.upArrow) setView({ ...v, cursor: (v.cursor + entries.length - 1) % Math.max(1, entries.length), preview: null })
      else if (key.downArrow) setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, entries.length), preview: null })
      else if (key.leftArrow || key.rightArrow) {
        if (entry?.kind === 'bool') setView({ ...v, preview: !(v.preview ?? entry.value) })
        else setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null })
      }
      else if (key.return) {
        if (entry?.kind === 'goto') setView({ kind: 'config', path: entry.subPath, cursor: 0, preview: null })
        else if (entry?.kind === 'scalar') setView({ kind: 'prompt', title: `输入 ${entry.label}`, value: entry.value, onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'prompt') setView({ kind: 'prompt', title: entry.title, value: '', onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'bool') { entry.save(v.preview ?? entry.value); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) }
        else if (entry?.kind === 'action') entry.run()
      }
      else if (key.escape) {
        const parent = parentPath(v.path)
        if (parent) setView({ kind: 'config', path: parent, cursor: 0, preview: null })
        else setView({ kind: 'none' })
      }
      else if (inputChar === 'd' && entry?.kind === 'goto' && entry.del) entry.del()
    }
  })

  const handleSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (text.startsWith('/')) {
      suppressEnterRef.current = true
      queueMicrotask(() => { suppressEnterRef.current = false })
      const cmd = text.split(/\s+/)[0]!
      switch (cmd) {
        case '/new': agent.send({ type: 'new_session' }); break
        case '/session': agent.send({ type: 'list_sessions' }); break
        case '/model': configIntent.current = 'model'; agent.send({ type: 'config_request' }); break
        case '/config': configIntent.current = 'config'; agent.send({ type: 'config_request' }); break
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

  const configEntries = view.kind === 'config' && configSnapshot ? buildEntries(configSnapshot, view.path, treeCtx) : []

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" flexGrow={1}>
        {chat.blocks.map((b, i) => {
          const isMarkdown = b.icon === ICON.assistant || b.icon === ICON.thinking
          const text = isMarkdown ? renderMarkdown(b.text) : b.text
          return (
            <MessageBlock key={i} icon={b.icon} role={b.role} color={b.color}>
              <Text>{text}</Text>
            </MessageBlock>
          )
        })}
        {chat.partial ? (
          <MessageBlock icon={ICON.assistant} role="助手（流式）" color={COLOR.assistant}>
            <Text>{chat.partial.text}</Text>
          </MessageBlock>
        ) : null}
      </Box>

      {view.kind === 'permission' && (
        <ListPicker title={`工具 ${view.tool} 请求权限`} items={DECISION_LABELS} cursor={view.cursor} hint="↑↓ 选择 · 回车确认 · esc 拒绝" />
      )}
      {view.kind === 'menu' && (
        <ListPicker title={view.title} items={view.items.map((i) => i.label)} cursor={view.cursor} hint="↑↓ 选择 · 回车确认 · esc 返回" />
      )}
      {view.kind === 'prompt' && (
        <Box>
          <Text color="cyan">{view.title} → </Text>
          <TextInput value={view.value} onChange={(val) => setView({ ...view, value: val })} onSubmit={(val) => { view.onSubmit(val); setView({ kind: 'none' }) }} />
        </Box>
      )}
      {view.kind === 'config' && (
        <ListPicker
          title={`配置 / ${view.path.kind}`}
          items={configEntries.map((e, i) => entryLabel(e, i === view.cursor && e.kind === 'bool' ? (view.preview ?? e.value) : undefined))}
          cursor={view.cursor}
          hint="↑↓ 选择 · 回车钻入/编辑 · ←→ 切布尔 · d 删 · esc 返回"
        />
      )}

      {view.kind === 'none' && <StatusBar state={chat.status} />}
      {view.kind === 'none' && (
        <Box>
          <Text color="blue">› </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        </Box>
      )}
    </Box>
  )
}