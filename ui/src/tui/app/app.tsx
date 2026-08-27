import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { AgentToUiMessage, UiToAgentMessage, PermissionDecision, Config, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, ListPicker } from '../components'
import { renderMarkdown } from '../markdown'
import { reducer, ICON, HELP, buildDisplayBlocks, sliceViewport, expandableIndices, moveBrowse, toggleExpanded, type ChatState } from '../chat'
import { parseCommand } from '../input'
import { buildEntries, entryLabel, parentPath, type ConfigPath, type TreeCtx } from '../overlays/config'
import { type View } from './view-state'

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']

// App 是 UI 的唯一入口。通过 UiPort 收发消息，不依赖 Agent——解耦落点。
// 后端消息经 port.onMessage → dispatch（reducer）+ view 切换；用户输入经 port.post 发给后端。
export function App({ port }: { port: UiPort }) {
  const { stdout } = useStdout()
  const [chat, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: null } as ChatState)
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const [input, setInput] = useState('')
  const [configSnapshot, setConfigSnapshot] = useState<Config | null>(null)
  const [scroll, setScroll] = useState(0)
  const [browse, setBrowse] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // view/config 用 ref 镜像，避免 Ink useInput 回调闭包过期（useState 在回调里拿到的是旧值）。
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  const configIntent = useRef<'model' | 'config' | null>(null)
  const suppressEnterRef = useRef(false)
  const browseRef = useRef<number | null>(null)
  const expandedRef = useRef<Set<number>>(new Set())
  const blocksRef = useRef(chat.blocks)

  const setBrowseBoth = useCallback((i: number | null) => { browseRef.current = i; setBrowse(i) }, [])
  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const updateConfig = useCallback((c: Config) => { configRef.current = c; setConfigSnapshot(c) }, [])
  const openMenu = useCallback((title: string, items: { label: string; onSelect: () => void }[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])

  useEffect(() => { blocksRef.current = chat.blocks }, [chat.blocks])

  // 块清空时复位浏览焦点与展开状态，避免残留下标误展开新块。
  useEffect(() => {
    if (chat.blocks.length === 0) {
      setBrowseBoth(null)
      expandedRef.current = new Set()
      setExpanded(new Set())
    }
  }, [chat.blocks.length, setBrowseBoth])

  // 配置树变更入口：翻译成 config_set/add/remove 消息发给后端。
  const treeCtx: TreeCtx = {
    set: (path, value) => port.post({ type: 'config_set', path, value }),
    add: (path, value) => port.post({ type: 'config_add', path, value }),
    remove: (path, index, providerIndex) => port.post({ type: 'config_remove', path, index, providerIndex }),
  }

  // /model 快捷：provider → model 两级选择器。
  const openModelPicker = useCallback((config: Config) => {
    openMenu('选择 provider', config.providers.map((p) => ({
      label: p.name || '（未命名）',
      onSelect: () => openMenu(`选择模型（${p.name || '未命名'}）`, p.models.map((m) => ({
        label: `${m.name || '（未命名）'}${m.reasoning ? ' · reasoning' : ''}`,
        onSelect: () => {
          port.post({ type: 'config_set', path: 'defaultProvider', value: p.name })
          port.post({ type: 'config_set', path: 'defaultModel', value: m.name })
          setView({ kind: 'none' })
        },
      }))),
    })))
  }, [openMenu, port, setView])

  const openConfigTree = useCallback((config: Config) => {
    updateConfig(config)
    setView({ kind: 'config', path: { kind: 'root' }, cursor: 0, preview: null })
  }, [updateConfig, setView])

  // 订阅后端消息：dispatch 到 reducer + 按 msg.type 切换 overlay。
  useEffect(() => {
    const off = port.onMessage((msg: AgentToUiMessage) => {
      dispatch(msg)
      if (msg.type === 'permission_request') {
        setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, cursor: 0 })
      } else if (msg.type === 'session_list') {
        openMenu('选择会话（回车切换）', msg.sessions.map((s) => ({
          label: `${s.id}  ${s.preview}`,
          onSelect: () => { port.post({ type: 'resume_session', id: s.id }); setView({ kind: 'none' }) },
        })))
      } else if (msg.type === 'config_state') {
        updateConfig(msg.config)
        if (configIntent.current === 'model') openModelPicker(msg.config)
        else if (configIntent.current === 'config') openConfigTree(msg.config)
      } else if (msg.type === 'config_updated') {
        updateConfig(msg.config)
      }
    })
    // 订阅后主动取一次配置，用于顶部品牌头展示当前 provider/model。
    port.post({ type: 'config_request' })
    return off
  }, [port, openMenu, openModelPicker, openConfigTree, updateConfig, setView])

  // 键盘路由：按 view 类型分发到不同处理。
  useInput((inputChar, key) => {
    // 命令提交的回车会被 TextInput 与 useInput 各处理一次：吞掉紧随命令后的第一次回车，避免误触发 overlay。
    if (key.return && suppressEnterRef.current) { suppressEnterRef.current = false; return }
    const v = viewRef.current

    if (v.kind === 'permission') {
      if (key.upArrow) setView({ ...v, cursor: (v.cursor + DECISIONS.length - 1) % DECISIONS.length })
      else if (key.downArrow) setView({ ...v, cursor: (v.cursor + 1) % DECISIONS.length })
      else if (key.return) { port.post({ type: 'permission_decision', id: v.id, decision: DECISIONS[v.cursor]! }); setView({ kind: 'none' }) }
      else if (key.escape) { port.post({ type: 'permission_decision', id: v.id, decision: 'reject' }); setView({ kind: 'none' }) }
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
      } else if (key.return) {
        if (entry?.kind === 'goto') setView({ kind: 'config', path: entry.subPath, cursor: 0, preview: null })
        else if (entry?.kind === 'scalar') setView({ kind: 'prompt', title: `输入 ${entry.label}`, value: entry.value, onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'prompt') setView({ kind: 'prompt', title: entry.title, value: '', onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'bool') { entry.save(v.preview ?? entry.value); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) }
        else if (entry?.kind === 'action') entry.run()
      } else if (key.escape) {
        const parent = parentPath(v.path)
        if (parent) setView({ kind: 'config', path: parent, cursor: 0, preview: null })
        else setView({ kind: 'none' })
      } else if (inputChar === 'd' && entry) {
        if (entry.kind === 'goto' && entry.del) entry.del()
        else if (entry.kind === 'action' && entry.del) entry.del()
      }
    } else if (v.kind === 'none') {
      // 消息视口：↑/↓ 在可折叠块间移动焦点，回车展开/折叠，esc 退回输入框。
      const expandable = expandableIndices(blocksRef.current)
      if (expandable.length > 0 && (key.upArrow || key.downArrow)) {
        setBrowseBoth(moveBrowse(blocksRef.current, browseRef.current, key.upArrow))
        return
      }
      if (key.return && browseRef.current !== null) { toggleExpanded(expandedRef.current, browseRef.current); setExpanded(new Set(expandedRef.current)); return }
      if (key.escape && browseRef.current !== null) { setBrowseBoth(null); return }
      // 手动滚动：PageUp 上翻、PageDown 下翻（scroll=0 时自动跟随最新）。
      const page = Math.max(5, Math.floor((stdout.rows || 24) / 2))
      if (key.pageUp) setScroll((s) => s + page)
      else if (key.pageDown) setScroll((s) => Math.max(0, s - page))
    }
  })

  const handleSubmit = (raw: string) => {
    const result = parseCommand(raw)
    if (result.kind === 'user' && !result.text) return
    setScroll(0)
    if (result.kind === 'user') {
      dispatch({ type: 'local_user', text: result.text })
      port.post({ type: 'submit', text: result.text })
    } else if (result.kind === 'help') {
      // /help 后面需要吞掉这次回车，避免在刚渲染的块上误触发。
      suppressEnterRef.current = true
      queueMicrotask(() => { suppressEnterRef.current = false })
      dispatch({ type: 'local_help' })
    } else {
      // 命令消息：/model /config 需要 intent 标记（后端回 config_state 时据此打开对应 overlay）。
      if (result.msg.type === 'config_request') {
        suppressEnterRef.current = true
        queueMicrotask(() => { suppressEnterRef.current = false })
        // 从命令文本推断 intent（/model vs /config）
        const cmd = raw.trim().split(/\s+/)[0]
        configIntent.current = cmd === '/model' ? 'model' : 'config'
      }
      port.post(result.msg)
    }
    setInput('')
  }

  // 渲染计算
  const configEntries = view.kind === 'config' && configSnapshot ? buildEntries(configSnapshot, view.path, treeCtx) : []
  const termWidth = stdout.columns || 80
  const viewportHeight = Math.max(6, (stdout.rows || 24) - 6)
  const headerInfo = configSnapshot
    ? (configSnapshot.defaultProvider ? `${configSnapshot.defaultProvider}/${configSnapshot.defaultModel ?? '?'}` : '未配置 provider（请先 /config）')
    : '加载配置中…'

  // markdown 渲染（助手/思考块）+ 展开/折叠状态 + 行数估算 + 滚动窗口裁切。
  const renderedBlocks = chat.blocks.map((b) => ({
    ...b,
    text: b.icon === ICON.assistant || b.icon === ICON.thinking ? renderMarkdown(b.text) : b.text,
  }))
  const displayBlocks = buildDisplayBlocks(renderedBlocks, expanded, termWidth, (icon) => icon === ICON.assistant || icon === ICON.thinking)
  const visibleBlocks = sliceViewport(displayBlocks, viewportHeight, scroll)

  return (
    <Box flexDirection="column" padding={1}>
      <TopBar info={headerInfo} />

      {/* 消息视口：外层圆角框 + 内部各消息块；思考块默认折叠 */}
      <Box flexGrow={1} borderStyle="round" borderColor="#6c7086" flexDirection="column" paddingX={1}>
        {chat.blocks.length === 0 && !chat.partial ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color="#94e2d5">🐶🥚 欢迎使用 DogEggAgent</Text>
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
            color={chat.partial.kind === 'thinking' ? '#f9e2af' : '#cdd6f4'}
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
