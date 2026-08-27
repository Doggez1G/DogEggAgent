import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { AgentToUiMessage, UiToAgentMessage, PermissionDecision, Config, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, ListPicker } from '../components'
import { palette } from '../theme'
import { renderMarkdown } from '../markdown'
import { reducer, ICON, HELP, buildDisplayBlocks, sliceViewport, expandableIndices, moveBrowse, toggleExpanded, type ChatState } from '../chat'
import { parseCommand, matchCommands } from '../input'
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
  const [suggestCursor, setSuggestCursor] = useState<number | null>(null) // 联想提示选中索引（null=未选中）
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
      } else if (msg.type === 'tools_list') {
        setView({ kind: 'info', title: '工具', lines: msg.tools.map((t) => `${t.name} — ${t.description}`) })
      } else if (msg.type === 'status_state') {
        setView({ kind: 'info', title: '状态', lines: [
          `session   ${msg.sessionId}`,
          `provider  ${msg.provider}`,
          `model     ${msg.model}`,
          `cwd       ${msg.cwd}`,
          `state     ${msg.state}`,
          `context   ${msg.estimatedTokens} / ${msg.windowTokens}`,
        ] })
      } else if (msg.type === 'context_state') {
        setView({ kind: 'info', title: '上下文', lines: [
          `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`,
          `压缩阈值：窗口 80% = ${Math.round(msg.windowTokens * 0.8)}`,
        ] })
      } else if (msg.type === 'system_state') {
        setView({ kind: 'info', title: 'system prompt', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.content] })
      } else if (msg.type === 'compaction') {
        setView({ kind: 'info', title: '压缩上下文', lines: [`压缩前：${msg.before_tokens} tokens`, `压缩后：${msg.after_tokens} tokens`] })
      } else if (msg.type === 'log_state') {
        setView({ kind: 'info', title: '调试日志', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.tail] })
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
      // 斜杠命令联想提示：输入以 / 开头且有匹配时，↑↓ 选择、回车/Tab 补全。
      const matches = matchCommands(input)
      if (matches.length > 0) {
        if (key.upArrow) { setSuggestCursor((c) => c === null ? matches.length - 1 : (c - 1 + matches.length) % matches.length); return }
        if (key.downArrow) { setSuggestCursor((c) => c === null ? 0 : (c + 1) % matches.length); return }
        if ((key.return || key.tab) && suggestCursor !== null) {
          // 补全选中命令到输入框，光标留在输入框等用户再按回车提交。
          setInput(matches[suggestCursor]!.cmd)
          setSuggestCursor(null)
          return
        }
        if (key.escape) { setSuggestCursor(null); return }
      }
      // 消息视口：↑/↓ 在可折叠块间移动焦点，回车展开/折叠，esc 退回输入框。
      const expandable = expandableIndices(blocksRef.current)
      if (expandable.length > 0 && (key.upArrow || key.downArrow)) {
        setBrowseBoth(moveBrowse(blocksRef.current, browseRef.current, key.upArrow))
        return
      }
      if (key.return && browseRef.current !== null) {
        // toggleExpanded 返回新 Set；需同时更新 ref 和 state（useInput 回调闭包读 ref，渲染读 state）。
        const next = toggleExpanded(expandedRef.current, browseRef.current)
        expandedRef.current = next
        setExpanded(next)
        return
      }
      if (key.escape && browseRef.current !== null) { setBrowseBoth(null); return }
      // 消息滚动：↑/↓ 在无可折叠块时滚动历史（PageUp/PageDown 也支持）。
      const page = Math.max(5, Math.floor((stdout.rows || 24) / 2))
      if (key.pageUp) setScroll((s) => s + page)
      else if (key.pageDown) setScroll((s) => Math.max(0, s - page))
      else if (key.upArrow && expandable.length === 0) setScroll((s) => s + 1)
      else if (key.downArrow && expandable.length === 0) setScroll((s) => Math.max(0, s - 1))
    } else if (v.kind === 'info') {
      // 信息面板：esc 关闭，↑/↓ 翻页（面板内容可能超屏）。
      if (key.escape) setView({ kind: 'none' })
      else if (key.upArrow) setScroll((s) => s + Math.max(3, Math.floor((stdout.rows || 24) / 3)))
      else if (key.downArrow) setScroll((s) => Math.max(0, s - Math.max(3, Math.floor((stdout.rows || 24) / 3))))
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
      // /help 改为 info overlay 呈现命令列表，不再塞消息块。
      suppressEnterRef.current = true
      queueMicrotask(() => { suppressEnterRef.current = false })
      setView({ kind: 'info', title: '帮助', lines: [
        '/new 新建会话      /config 编辑配置',
        '/session 切换会话   /model 快速切模型',
        '/clear 清空历史     /compact 手动压缩',
        '/context 查看占用   /tools 列出工具',
        '/system 系统提示词  /status 状态一览',
        '/log 调试日志       /quit 退出       /help 本帮助',
      ] })
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
  // 滚动裁切：计算总行数与可见窗口，scrolled > 0 表示有内容被滚出顶部。
  const totalLines = displayBlocks.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  const visibleBlocks = sliceViewport(displayBlocks, viewportHeight, scroll)

  return (
    <Box flexDirection="column" padding={1}>
      <TopBar info={headerInfo} />

      {/* 消息视口：无外框（消息块自带左色条），用 flexGrow 占满 + 内部滚动 */}
      <Box flexGrow={1} flexDirection="column" paddingBottom={1}>
        {chat.blocks.length === 0 && !chat.partial ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color="#94e2d5">🐶🥚 欢迎使用 DogEggAgent</Text>
            <Text dimColor>输入任务开始对话，输入 /help 查看命令{configSnapshot && configSnapshot.providers.length === 0 ? '；首次请先 /config 配置 provider' : ''}</Text>
          </Box>
        ) : (
          visibleBlocks.map((b) => (
            <MessageBlock key={b.index} icon={b.icon} role={b.role} color={b.color} focused={browse === b.index}>
              {b.isCollapsed ? (
                // 折叠状态：思考块和工具块各自显示折叠提示（选中时提示可展开）
                <Text dimColor>{b.icon === ICON.thinking
                  ? (browse === b.index ? '（思考已折叠 · 回车展开）' : '（思考已折叠）')
                  : (browse === b.index ? '（结果已折叠 · 回车展开）' : '（结果已折叠）')}</Text>
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
        {scrolled > 0 && (
          <Text dimColor>↑ {scrolled} 行历史（↑↓ 或 PageUp/PageDown 滚动）</Text>
        )}
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

      {view.kind === 'info' && (
        <Box flexDirection="column" borderStyle="round" borderColor="#6c7086" paddingX={1} marginY={1}>
          <Text bold color="#89b4fa">{view.title}</Text>
          <Box flexDirection="column" marginTop={0}>
            {view.lines.map((line, i) => (
              <Text key={i} dimColor={line.startsWith('─') || line.startsWith('路径')}>{line}</Text>
            ))}
          </Box>
          <Text dimColor>↑↓ 翻页 · esc 关闭</Text>
        </Box>
      )}

      {view.kind === 'none' && <StatusBar state={chat.status} />}
      {view.kind === 'none' && (
        <Box flexDirection="column">
          {browse !== null && <Text dimColor>↑↓ 切换块 · 回车展开/折叠 · esc 返回输入</Text>}
          {/* 斜杠命令联想提示：输入 / 开头且有匹配时，显示列表供 ↑↓ 选择、回车/Tab 补全 */}
          {matchCommands(input).length > 0 && (
            <Box flexDirection="column" marginTop={0}>
              {matchCommands(input).map((m, i) => (
                <Text key={m.cmd} inverse={i === suggestCursor} color={i === suggestCursor ? undefined : palette.subtext}>
                  {i === suggestCursor ? '> ' : '  '}{m.cmd} {m.desc}
                </Text>
              ))}
              <Text dimColor> ↑↓ 选择 · 回车/Tab 补全 · esc 取消</Text>
            </Box>
          )}
          <Box>
            <Text color="blue">› </Text>
            <TextInput value={input} onChange={(v) => { setInput(v); setSuggestCursor(null) }} onSubmit={handleSubmit} focus={browse === null} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
