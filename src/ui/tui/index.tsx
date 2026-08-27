import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { Agent } from '../../agent/index'
import type { AgentToUiMessage } from '../../events/agent-to-ui'
import type { PermissionDecision } from '../../events/types'
import type { Config } from '../../config/schema'
import { MessageBlock, StatusBar, ListPicker, TopBar, palette, type BlockColor } from './components'
import { renderMarkdown } from '../../common/utils/markdown'
import { buildEntries, entryLabel, parentPath, type ConfigPath, type TreeCtx } from './config-tree'

interface Block {
  icon: string
  role: string
  color: BlockColor
  text: string
  // 可折叠块的完整内容（工具为完整结果，思考块的 text 本就是完整推理由折叠时隐藏）。折叠时显示 text 摘要，展开时显示 full。
  full?: string
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
const COLOR: Record<keyof typeof ICON, BlockColor> = { user: palette.accent, assistant: palette.text, tool: palette.cyan, thinking: palette.yellow }

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']
const HELP = '/new /session /model /config /clear /compact /context /tools /system /status /log /help /quit'

// 粗略估算一个消息块占用的终端行数（角色头 1 + 正文换行 + 上下边框 2），用于消息视口的自动滚动裁切。
function estimateBlockLines(text: string, width: number): number {
  const lineWidth = Math.max(10, width - 6)
  const body = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / lineWidth)), 0)
  return body + 3
}

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
        // 折叠显示：调用 + 截断摘要；full 存「调用 + 完整结果」供展开查看。
        const summary = msg.error ? `✕ ${msg.error}` : `✓ 完成（${msg.output.slice(0, 120)}${msg.output.length > 120 ? '…' : ''}）`
        const fullText = msg.error ? `✕ ${msg.error}` : `✓ 完成\n${msg.output}`
        blocks[blocks.length - 1] = { ...last, text: `${last.text}\n${summary}`, full: `${last.text}\n${fullText}` }
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
      return {
        ...state,
        status: 'idle',
        blocks: msg.messages.flatMap((m): Block[] => {
          if (m.role === 'assistant') {
            const content = (m as { content: string | null }).content
            if (!content) return [] // 纯 tool_calls 的 assistant 消息：其后紧跟工具块，跳过避免空块
            return [{ icon: ICON.assistant, role: '助手', color: COLOR.assistant, text: content }]
          }
          if (m.role === 'tool') return [{ icon: ICON.tool, role: '工具结果', color: COLOR.tool, text: m.content }]
          return [{ icon: ICON.user, role: '你', color: COLOR.user, text: m.content }]
        }),
      }
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
  const { stdout } = useStdout()
  const [chat, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: null })
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const [input, setInput] = useState('')
  const [configSnapshot, setConfigSnapshot] = useState<Config | null>(null)
  const [scroll, setScroll] = useState(0)
  const [browse, setBrowse] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  const configIntent = useRef<'model' | 'config' | null>(null)
  const suppressEnterRef = useRef(false)
  const browseRef = useRef<number | null>(null)
  const expandedRef = useRef<Set<number>>(new Set())
  const blocksRef = useRef<Block[]>([])

  // 块浏览/展开状态既用于渲染也用 useInput 读取，故用 ref 镜像，避免 Ink 输入回调里的闭包过期。
  const setBrowseBoth = useCallback((i: number | null) => {
    browseRef.current = i
    setBrowse(i)
  }, [])

  const toggleExpanded = useCallback((i: number) => {
    const next = new Set(expandedRef.current)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    expandedRef.current = next
    setExpanded(next)
  }, [])

  useEffect(() => {
    blocksRef.current = chat.blocks
  }, [chat.blocks])

  // 清空历史 / 切换会话导致块清空时，浏览焦点与展开状态一并复位，避免残留下标误展开新块。
  useEffect(() => {
    if (chat.blocks.length === 0) {
      setBrowseBoth(null)
      expandedRef.current = new Set()
      setExpanded(new Set())
    }
  }, [chat.blocks.length, setBrowseBoth])

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
    const off = agent.on((msg) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, cursor: 0 })
      } else if (msg.type === 'session_list') {
        openMenu('选择会话（回车切换）', msg.sessions.map((s) => ({
          label: `${s.id}  ${s.preview}`,
          onSelect: () => { agent.send({ type: 'resume_session', id: s.id }); setView({ kind: 'none' }) },
        })))
      } else if (msg.type === 'config_state') {
        updateConfig(msg.config)
        if (configIntent.current === 'model') openModelPicker(msg.config)
        else if (configIntent.current === 'config') openConfigTree(msg.config)
      } else if (msg.type === 'config_updated') {
        // 配置变更后刷新快照，配置树会按当前 path 重新渲染。
        updateConfig(msg.config)
      }
    })
    // 订阅后主动取一次配置，用于顶部品牌头展示当前 provider/model。
    agent.send({ type: 'config_request' })
    return off
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
      else if (inputChar === 'd' && entry) {
        if (entry.kind === 'goto' && entry.del) entry.del()
        else if (entry.kind === 'action' && entry.del) entry.del()
      }
    } else if (v.kind === 'none') {
      // 消息视口：↑/↓ 在可折叠块（思考/工具）间移动浏览焦点，回车展开/折叠，esc 退回输入框。
      // 用方向键而非 Tab：ink-text-input 会忽略 ↑/↓，且方向键在本终端已被菜单/配置树验证可靠。
      const expandable = blocksRef.current
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.icon === ICON.thinking || b.icon === ICON.tool)
        .map(({ i }) => i)

      if (expandable.length > 0 && (key.upArrow || key.downArrow)) {
        const cur = browseRef.current
        const idx = cur === null ? -1 : expandable.indexOf(cur)
        // 未聚焦时按 ↑ 从最后一个（最近）开始，↓ 从第一个开始；已聚焦则按方向在原地上下移动并回绕。
        const next = key.upArrow
          ? expandable[(idx < 0 ? expandable.length - 1 : (idx - 1 + expandable.length) % expandable.length)]!
          : expandable[(idx < 0 ? 0 : (idx + 1) % expandable.length)]!
        setBrowseBoth(next)
        return
      }
      if (key.return && browseRef.current !== null) {
        toggleExpanded(browseRef.current)
        return
      }
      if (key.escape && browseRef.current !== null) {
        setBrowseBoth(null)
        return
      }

      // 手动滚动：PageUp 上翻、PageDown 下翻（scroll=0 时自动跟随最新）。
      const page = Math.max(5, Math.floor((stdout.rows || 24) / 2))
      if (key.pageUp) setScroll((s) => s + page)
      else if (key.pageDown) setScroll((s) => Math.max(0, s - page))
    }
  })

  const handleSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    setScroll(0)
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

  const termWidth = stdout.columns || 80
  const viewportHeight = Math.max(6, (stdout.rows || 24) - 6)
  const headerInfo = configSnapshot
    ? (configSnapshot.defaultProvider ? `${configSnapshot.defaultProvider}/${configSnapshot.defaultModel ?? '?'}` : '未配置 provider（请先 /config）')
    : '加载配置中…'

  const renderedBlocks = chat.blocks.map((b) => {
    const isMd = b.icon === ICON.assistant || b.icon === ICON.thinking
    return { ...b, text: isMd ? renderMarkdown(b.text) : b.text }
  })
  // 每块「实际显示文本」按展开状态决定：可折叠块（思考/工具）折叠时显示摘要，展开时显示 full。
  // 行数据此估算，保证展开后滚动裁剪仍准确。
  type DisplayBlock = (typeof renderedBlocks)[number] & { index: number; lines: number; shownText: string; isCollapsed: boolean }
  const displayBlocks: DisplayBlock[] = renderedBlocks.map((b, i) => {
    const expandable = b.icon === ICON.thinking || b.icon === ICON.tool
    const isExpanded = expanded.has(i)
    const shownText = !expandable
      ? b.text
      : isExpanded
        ? (b.icon === ICON.tool ? (b.full ?? b.text) : b.text)
        : (b.icon === ICON.thinking ? '（思考已折叠）' : b.text)
    return { ...b, index: i, lines: estimateBlockLines(shownText, termWidth), shownText, isCollapsed: expandable && !isExpanded }
  })
  const totalLines = displayBlocks.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  const visibleTop = totalLines - viewportHeight - scrolled
  let acc = 0
  const visibleBlocks: DisplayBlock[] = []
  for (const b of displayBlocks) {
    const start = acc
    acc += b.lines
    if (acc <= visibleTop) continue
    if (start >= visibleTop + viewportHeight) break
    visibleBlocks.push(b)
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* 顶部品牌条 */}
      <TopBar info={headerInfo} />

      {/* 消息视口：外层圆角框 + 内部各消息块；思考块默认折叠 */}
      <Box flexGrow={1} borderStyle="round" borderColor={palette.subtext} flexDirection="column" paddingX={1}>
        {chat.blocks.length === 0 && !chat.partial ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color={palette.cyan}>🐶🥚 欢迎使用 DogEggAgent</Text>
            <Text dimColor>输入任务开始对话，输入 /help 查看命令{configSnapshot && configSnapshot.providers.length === 0 ? '；首次请先 /config 配置 provider' : ''}</Text>
          </Box>
        ) : (
          visibleBlocks.map((b) => (
            <MessageBlock key={b.index} icon={b.icon} role={b.role} color={b.color} focused={browse === b.index}>
              {b.icon === ICON.thinking && b.isCollapsed ? (
                <Text dimColor>{browse === b.index ? '（思考已折叠 · 回车展开）' : '（思考已折叠）'}</Text>
              ) : (
                <Text>{b.shownText}</Text>
              )}
            </MessageBlock>
          ))
        )}
        {chat.partial ? (
          <MessageBlock
            icon={chat.partial.kind === 'thinking' ? ICON.thinking : ICON.assistant}
            role={chat.partial.kind === 'thinking' ? '思考（流式）' : '助手（流式）'}
            color={chat.partial.kind === 'thinking' ? COLOR.thinking : COLOR.assistant}
          >
            <Text dimColor={chat.partial.kind === 'thinking'}>{chat.partial.text}</Text>
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
          <TextInput
            value={view.value}
            onChange={(val) => setView({ ...view, value: val })}
            onSubmit={(val) => {
              // 提交后去哪由 view.onSubmit 决定（配置标量会回到配置树原位，而非退出）；
              // 这里只吞掉这次回车，避免它被 useInput 再触发一次误操作。
              suppressEnterRef.current = true
              queueMicrotask(() => { suppressEnterRef.current = false })
              view.onSubmit(val)
            }}
          />
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
        <Box flexDirection="column">
          {browse !== null && <Text dimColor>↑↓ 切换块 · 回车展开/折叠 · esc 返回输入</Text>}
          <Box>
            <Text color="blue">› </Text>
            <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} focus={browse === null} />
          </Box>
        </Box>
      )}
    </Box>
  )
}