import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Static, Text } from 'ink'
import type { Config, ToolListItem, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, MultilineInput, StreamingBlock, PendingTool } from '../components'
import { palette, themeRegistry } from '../theme'
import { renderMarkdown } from '../markdown'
import { clearScreen } from './entry'
import { spawnSync } from 'node:child_process'
import { reducer, type ChatState, type Block, parseCommand, matchCommands } from '../../shared'
import { matchPathToken, applyPathCompletion, PATH_SUGGEST_WINDOW } from '../features/input'
import { buildEntries, type Entry, type TreeCtx } from '../features/config'
import { useKeyRouting } from './use-key-routing'
import { useChat } from './use-chat'
import { useAgentEvents, type StatusBarData } from './use-agent-events'
import type { McpServerEntry, SkillEntry } from '../view-state'
import { McpPanel } from '../features/mcp'
import { FormPanel } from '../features/form'
import { PermissionOverlay } from '../features/permission/view'
import { MenuOverlay } from '../features/menu/view'
import { SessionPickerOverlay } from '../features/sessions/view'
import { SkillsPanel } from '../features/skills'
import { ConfigOverlay } from '../features/config/view'
import { InfoOverlay } from '../features/info/view'
import { PromptOverlay } from '../features/prompt/view'
import { BrowseStatusBar } from '../features/browse/view'
import { type View } from '../view-state'

// Static items 的类型：首项是品牌头（启动打印一次），其余是已完成的消息块。
type StaticItem = { type: 'header' } | { type: 'block'; block: Block }

// App 是 UI 的装配层：chat 数据域（use-chat）+ 视图事件域（use-agent-events）+
// 键盘路由（use-key-routing → features/*/keys）+ 布局渲染。
// 架构（Claude Code 式）：已完成的消息块经 <Static> 打印进终端滚动缓冲区，
// 用户用终端原生滚动查看历史；Ink 只重绘底部动态区（未完成块+流式+输入+状态栏）。
export function App({ port }: { port: UiPort }) {
  const { chat, dispatch } = useChat(port)
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const [input, setInput] = useState('')
  const [configSnapshot, setConfigSnapshot] = useState<Config | null>(null)
  const [suggestCursor, setSuggestCursorState] = useState<number | null>(null) // 联想提示选中索引（null=未选中）
  const suggestCursorRef = useRef<number | null>(null) // 镜像供 handleSubmit 读取（闭包防过期）
  const setSuggestCursor = useCallback((c: number | null) => { suggestCursorRef.current = c; setSuggestCursorState(c) }, [])
  const [infoScroll, setInfoScroll] = useState(0) // info overlay 独立翻页
  const [statusBarData, setStatusBarData] = useState<StatusBarData>({})
  const [toolsList, setToolsList] = useState<ToolListItem[]>([]) // 运行时工具清单（/config 选择器 + /tools 面板，身份随行）
  const [skillsList, setSkillsList] = useState<SkillEntry[]>([]) // skills 清单镜像（/skills 面板 + 斜杠命令联想 + invoke 路由）
  const [mcpList, setMcpList] = useState<McpServerEntry[]>([]) // MCP server 状态镜像（/mcp 面板）
  const currentCwdRef = useRef<string>('')
  // 标记是否为显式信息请求（/context /status 等），用于区分轮询的静默更新。
  const explicitInfoRef = useRef(false)
  // /tools 的独立 intent 标志：工具面板只由显式 /tools 打开；后台播种（挂载/config_updated）不弹面板。
  const toolsIntentRef = useRef(false)
  // Static 重挂载 key——会话切换/清空/折叠展开切换时清屏重绘。
  const [staticKey, setStaticKey] = useState(0)
  // 浏览模式：Ctrl+Up/Down 在块间移动焦点，Enter 切换折叠/展开。
  const [browseIdx, setBrowseIdxState] = useState<number | null>(null)
  const browseIdxRef = useRef<number | null>(null)
  const setBrowseIdx = useCallback((i: number | null) => { browseIdxRef.current = i; setBrowseIdxState(i) }, [])
  // 展开状态（块索引 → 展开）。
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const expandedRef = useRef<Set<number>>(new Set())
  const blocksRef = useRef(chat.blocks)
  useEffect(() => { blocksRef.current = chat.blocks }, [chat.blocks])
  // 主题切换：清屏 + Static 重挂载（静态区重渲染；动态区经 staticKey 变更整体重渲染）。
  const inputHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef<number>(-1) // 输入历史游标（-1=未在浏览历史）
  // view/config 用 ref 镜像，避免 Ink useInput 回调闭包过期（useState 在回调里拿到的是旧值）。
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  // 配置树 entries 的 ref 镜像——按键层复用渲染层算好的同一份（useInput 回调读 state 拿旧值，走 ref）。
  const configEntriesRef = useRef<Entry[]>([])
  const configIntent = useRef<'model' | 'config' | null>(null)
  const statusRef = useRef(chat.status) // 镜像 chat.status 供 useInput 读取（闭包防过期）
  const cwdRef = useRef<string | undefined>(undefined) // 镜像 cwd 供 useInput/handleSubmit 读取（@path 联想）
  // @path 弹框的 Esc 关闭标记：弹框派生自输入文本，需要一个显式「已关闭」状态；
  // 输入一变即恢复（继续输入等于重新联想）。
  const [pathDismissed, setPathDismissed] = useState(false)
  useEffect(() => { setPathDismissed(false) }, [input])
  // 输入变化即复位联想光标：斜杠联想与 @path 联想共用 cursor，
  // 残留的选中下标会让下一次回车误补全（选中项被静默插入）而非提交。
  useEffect(() => { setSuggestCursor(null) }, [input, setSuggestCursor])

  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const updateConfig = useCallback((c: Config) => { configRef.current = c; setConfigSnapshot(c) }, [])
  const openMenu = useCallback((title: string, items: { label: string; onSelect: () => void }[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])
  // 折叠切换/会话切换的清屏 + Static 重挂载（Static 已输出内容无法就地修改）。
  const clearScreenRemount = useCallback(() => { clearScreen(); setStaticKey((k) => k + 1) }, [])
  useEffect(() => themeRegistry.onChange(clearScreenRemount), [clearScreenRemount])
  // 系统编辑器打开文件（skills 的「改」）：暂停 raw mode → spawnSync 阻塞至编辑器退出 → 恢复 + 清屏重挂 + 重拉清单。
  const openInEditor = useCallback((path: string) => {
    const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    try {
      stdin.setRawMode?.(false)
      spawnSync(editor, [path], { stdio: 'inherit' })
    } finally {
      stdin.setRawMode?.(wasRaw ?? true)
      clearScreenRemount()
      port.post({ type: 'skills_request' })
    }
  }, [clearScreenRemount, port])
  // 会话切换/清空后的 UI 复位。
  const onSessionCleared = useCallback(() => {
    setSuggestCursor(null)
    setBrowseIdx(null)
    expandedRef.current = new Set()
    setExpanded(new Set())
  }, [setSuggestCursor, setBrowseIdx])
  // 错误自动重填上次提交的文本到输入框，用户可直接改或重新提交。
  const onErrorRetry = useCallback(() => {
    if (inputHistoryRef.current.length === 0) return
    const lastText = inputHistoryRef.current[inputHistoryRef.current.length - 1]!
    setInput(lastText)
    historyCursorRef.current = -1
  }, [setInput])

  useEffect(() => { statusRef.current = chat.status }, [chat.status])
  cwdRef.current = statusBarData.cwd

  // 配置树变更入口：翻译成 config_set/add/remove 消息发给后端。
  const treeCtx: TreeCtx = {
    openSkills: () => setView({ kind: 'skills', cursor: 0, skills: skillsList }),
    openMcp: () => setView({ kind: 'mcp', cursor: 0, servers: mcpList }),
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

  // ── 键盘路由：按 view.kind 分派到 features/*/keys ──
  const { suppressEnter } = useKeyRouting({
    port,
    viewRef,
    setView,
    statusRef,
    configRef,
    treeCtx,
    configEntries: () => configEntriesRef.current,
    input,
    setInput,
    cwd: cwdRef.current,
    skillCommands: () => skillCommands,
    openEditor: openInEditor,
    pathDismissed,
    dismissPathSuggest: () => setPathDismissed(true),
    suggest: { get: () => suggestCursorRef.current, set: setSuggestCursor },
    browse: {
      get: () => browseIdxRef.current,
      set: setBrowseIdx,
      blocks: () => blocksRef.current,
      isExpanded: (i) => expandedRef.current.has(i),
      toggle: (i) => {
        const next = new Set(expandedRef.current)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        expandedRef.current = next
        setExpanded(next)
      },
    },
    infoScroll: setInfoScroll,
    history: { items: inputHistoryRef.current, cursor: historyCursorRef.current, setCursor: (c) => { historyCursorRef.current = c } },
    clearScreenRemount,
  })

  // ── 视图事件域：消息 → overlay 开合 / 状态栏 / 回填 ──
  useAgentEvents({
    port,
    viewRef,
    currentCwdRef,
    explicitInfoRef,
    toolsIntentRef,
    configIntentRef: configIntent,
    setView,
    updateConfig,
    openMenu,
    openModelPicker: (c) => openModelPicker(c),
    openConfigTree: (c) => openConfigTree(c),
    setStatusBarData,
    setToolsList,
    setSkillsList,
    setMcpList,
    clearScreenRemount,
    onSessionCleared,
    onErrorRetry,
    setInfoScroll,
  })

  // 运行中轮询 context_request（2s 间隔）——让 StatusBar 的 tokens 实时更新。
  useEffect(() => {
    const running = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'
    if (!running) return
    const timer = setInterval(() => port.post({ type: 'context_request' }), 2000)
    return () => clearInterval(timer)
  }, [port, chat.status])

  // ── 命令提交流程：联想拦截 → parseCommand → 确认弹层 → intent 标记 ──
  const handleSubmit = (raw: string) => {
    // @path 联想拦截：输入末尾有 @token 且选中了候选时，回车替换为补全路径而非提交（Esc 关闭后不拦截）。
    const ps = matchPathToken(raw, cwdRef.current)
    if (ps && !pathDismissed && suggestCursorRef.current !== null) {
      const entry = ps.entries[suggestCursorRef.current]
      if (entry) setInput(applyPathCompletion(raw, ps.replaceStart, entry))
      setSuggestCursor(null)
      return
    }
    // 联想补全拦截：有联想匹配且选中了项时，回车补全到输入框而非提交。
    const matches = matchCommands(raw)
    if (matches.length > 0 && suggestCursorRef.current !== null) {
      setInput(matches[suggestCursorRef.current]!.cmd)
      setSuggestCursor(null)
      return
    }
    const result = parseCommand(raw, skillsList.map((s) => s.name))
    if (result.kind === 'user' && !result.text) return
    if (result.kind === 'user') {
      dispatch({ type: 'local_user', text: result.text })
      inputHistoryRef.current.push(result.text)
      historyCursorRef.current = -1
      port.post({ type: 'submit', text: result.text })
    } else if (result.kind === 'help') {
      // /help 改为 info overlay 呈现命令列表，不再塞消息块。
      suppressEnter()
      setInfoScroll(0)
      setView({ kind: 'info', title: '帮助', lines: [
        '/new 新建会话      /config 编辑配置',
        '/session 切换会话   /model 快速切模型',
        '/clear 清空历史     /compact 手动压缩',
        '/cd 切换工作目录    /context 查看占用',
        '/tools 列出工具     /system 系统提示词',
        '/status 状态一览    /log 调试日志',
        '/permissions 会话权限  /skills 管理 skills',
        '/mcp 管理 MCP       /quit 退出',
        '/help 本帮助',
      ] })
    } else {
      // /clear 和 /quit 需确认弹层（不可逆操作）。
      if (result.msg.type === 'clear_history') {
        suppressEnter()
        openMenu('清空当前会话历史？此操作不可撤销。', [
          { label: '确认清空', onSelect: () => { port.post({ type: 'clear_history' }); setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => setView({ kind: 'none' }) },
        ])
        setInput('')
        return
      }
      if (result.msg.type === 'quit') {
        suppressEnter()
        openMenu('退出 DogEggAgent？', [
          { label: '确认退出', onSelect: () => { port.post({ type: 'quit' }); setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => setView({ kind: 'none' }) },
        ])
        setInput('')
        return
      }
      // 命令消息：/model /config 需要 intent 标记（后端回 config_state 时据此打开对应 overlay）。
      if (result.msg.type === 'config_request') {
        const cmd = raw.trim().split(/\s+/)[0]
        configIntent.current = cmd === '/model' ? 'model' : 'config'
      }
      // 显式信息请求标记：/context /status /system /log 会回 info overlay。
      // /tools 不共用此标志——tools_list 有后台播种（挂载/config_updated），共享会误消费
      // （编辑配置后立刻 /context，播种响应先到会抢开工具面板）。
      if (['context_request', 'status_request', 'system_request', 'log_request'].includes(result.msg.type)) {
        explicitInfoRef.current = true
      }
      if (result.msg.type === 'tools_request') {
        toolsIntentRef.current = true
      }
      // /session：先开空壳选择器，session_list 响应到达后填充（选择器已开才会被刷新——
      // 重命名/自动标题等后端推送不再承担弹层职责，见 use-agent-events）。
      if (result.msg.type === 'list_sessions') {
        setView({ kind: 'sessionPicker', sessions: [], cursor: 0, query: '' })
      }
      // /skills /mcp：先开面板壳，响应到达后填充（复用同一「响应只刷新已开面板」语义）。
      if (result.msg.type === 'skills_request') setView({ kind: 'skills', cursor: 0, skills: skillsList })
      if (result.msg.type === 'mcp_request') setView({ kind: 'mcp', cursor: 0, servers: mcpList })
      // 所有会打开 overlay 的命令统一吞掉提交回车——
      // port 是同步通道，agent 回响应可能立即设 view 为 menu/info，
      // 不吞的话同一个回车被 useInput 在新 view 里处理（误选中第一项）。
      suppressEnter()
      port.post(result.msg)
    }
    setInput('')
  }

  // ── 渲染 ──
  // 工具清单：运行时镜像为空时传 undefined——buildEntries 回退静态 KNOWN_TOOLS（空数组不是「无工具」而是「未播种」）。
  const configEntries = view.kind === 'config' && configSnapshot ? buildEntries(configSnapshot, view.path, treeCtx, toolsList.length > 0 ? toolsList : undefined) : []
  configEntriesRef.current = configEntries
  const skillCommands = skillsList.map((s) => ({ cmd: '/' + s.name, desc: `skill: ${s.description}` }))
  const suggestMatches = view.kind === 'none' ? matchCommands(input, skillCommands) : []
  const pathSuggest = view.kind === 'none' && suggestMatches.length === 0 && !pathDismissed ? matchPathToken(input, cwdRef.current) : null

  const headerInfo = configSnapshot
    ? (configSnapshot.defaultProvider ? `${configSnapshot.defaultProvider}/${configSnapshot.defaultModel ?? '?'}` : '未配置 provider（请先 /config）')
    : '加载配置中…'

  // Static items：品牌头 + 已完成的块（toolActive 时最后一块未完成，留在动态区）。
  // 品牌头延迟打印：Static 只在首现时渲染一次——启动瞬间 config/status 还没回来，
  // 先打印会永远定格在「加载配置中…」/ 短横线；等两者就绪再打印即为准确信息。
  const headerReady = configSnapshot !== null && statusBarData.cwd !== undefined
  const stableCount = chat.toolActive && chat.blocks.length > 0 ? chat.blocks.length - 1 : chat.blocks.length
  const staticItems: StaticItem[] = [
    ...(headerReady ? [{ type: 'header' as const }] : []),
    ...chat.blocks.slice(0, stableCount).map((block) => ({ type: 'block' as const, block })),
  ]

  // 动态区：未完成的 tool 块（会再更新）+ 流式 partial。
  const activeBlocks = chat.toolActive ? chat.blocks.slice(stableCount) : []

  return (
    <>
      {/* Static：已完成的块打印进终端缓冲区，永不重绘；用户用终端原生滚动查看历史 */}
      <Static key={staticKey} items={staticItems} style={{ width: "100%" }}>
        {(item, index) => {
          if (item.type === 'header') return <TopBar key="header" info={headerInfo} sessionId={statusBarData.sessionId} cwd={statusBarData.cwd} />
          // 块渲染前完成 markdown → 纯文本转换（Static 只渲染一次，无性能问题）。
          const isMd = item.block.kind === 'assistant' || item.block.kind === 'thinking'
          const block: Block = isMd
            ? {
                ...item.block,
                text: renderMarkdown(item.block.text),
                ...(item.block.full !== undefined ? { full: renderMarkdown(item.block.full) } : {}),
              }
            : item.block
          // 块原始索引 = items 索引 - 1（首项是 header）。
          return <MessageBlock key={index} block={block} expanded={expanded.has(index - 1)} />
        }}
      </Static>

      {/* 动态区：未完成块 + 流式 partial + 输入 + overlay + 状态栏，由 Ink 重绘 */}
      <Box flexDirection="column">
        {activeBlocks.map((b) => (
          <MessageBlock key={b.toolId ?? 'active'} block={b} />
        ))}
        {chat.partial ? (
          <StreamingBlock
            kind={chat.partial.kind}
            text={chat.partial.kind === 'thinking' ? chat.partial.text : renderMarkdown(chat.partial.text)}
          />
        ) : null}
        {/* 模型正在生成工具调用参数——流式文本冻结、工具块未出现的空窗期提示 */}
        {chat.pendingTool != null && <PendingTool name={chat.pendingTool} />}

        {browseIdx !== null && (
          <BrowseStatusBar idx={browseIdx} total={chat.blocks.length} block={chat.blocks[browseIdx]} expanded={expanded.has(browseIdx)} />
        )}

        {view.kind === 'none' && (
          <Box flexDirection="column">
            {suggestMatches.length > 0 && (() => {
              // 一行一条（长描述截断防换行）+ 滑动窗口（与 @path 联想同款，列表高度有上限）。
              const win = PATH_SUGGEST_WINDOW
              const total = suggestMatches.length
              const cur = suggestCursor ?? 0
              const start = Math.max(0, Math.min(cur - win + 1, total - win))
              const windowed = suggestMatches.slice(start, start + win)
              const trunc = (t: string): string => (t.length > 28 ? t.slice(0, 28) + '…' : t)
              return (
                <Box flexDirection="column">
                  {windowed.map((m, i) => {
                    const real = start + i
                    return (
                      <Text key={m.cmd} inverse={real === suggestCursor} color={real === suggestCursor ? undefined : palette.subtext}>
                        {real === suggestCursor ? '> ' : '  '}{m.cmd} <Text dimColor>{trunc(m.desc)}</Text>
                      </Text>
                    )
                  })}
                  {total > win && <Text dimColor>　…共 {total} 项（↑↓ 滚动选择）</Text>}
                </Box>
              )
            })()}
            {pathSuggest && (() => {
              // 候选全量返回，仅渲染光标附近的滑动窗口（↑↓ 时窗口跟随滚动）；超出窗口时提示总数。
              const total = pathSuggest.entries.length
              const win = PATH_SUGGEST_WINDOW
              const cur = suggestCursor ?? 0
              const start = Math.max(0, Math.min(cur - win + 1, total - win))
              const windowed = pathSuggest.entries.slice(start, start + win)
              return (
                <Box flexDirection="column">
                  {windowed.map((e, i) => {
                    const real = start + i
                    return (
                      <Text key={e.name} inverse={real === suggestCursor} color={real === suggestCursor ? undefined : palette.subtext}>
                        {real === suggestCursor ? '> ' : '  '}{e.name}{e.isDir ? '/' : ''}
                      </Text>
                    )
                  })}
                  {total > win && <Text dimColor>　…共 {total} 项（↑↓ 滚动选择）</Text>}
                </Box>
              )
            })()}
            {/* 输入框：surface 背景块 + 左侧 accent 竖线（OpenCode 同款） */}
            <Box
              borderStyle="round"
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              borderColor={palette.accent}
              backgroundColor={palette.surface}
              paddingX={1}
              paddingY={1}
              width="100%"
            >
              <MultilineInput value={input} onChange={(v) => { setInput(v); setSuggestCursor(null) }} onSubmit={handleSubmit} focus={browseIdx === null} placeholder="向狗蛋布置任务，或输入 / 命令…" />
            </Box>
            <Box marginTop={0}>
              <Text color={palette.cyan}>Enter 发送</Text>
              <Text color={palette.subtext}> · Ctrl+J/Alt+Enter 换行 · /help 命令</Text>
            </Box>
          </Box>
        )}
        {view.kind === 'prompt' && (
          <PromptOverlay view={view} setView={setView} suppressEnter={suppressEnter} />
        )}
        {view.kind !== 'none' && view.kind !== 'prompt' && (
          <Box>
            <Text color={palette.accent}>{'> '}</Text>
            <Text dimColor>{view.kind === 'permission' ? '权限请求中…'
              : view.kind === 'menu' ? view.title
              : view.kind === 'sessionPicker' ? '选择会话（输入过滤 · d 删除）'
              : view.kind === 'config' ? `配置 / ${view.path.kind}`
              : view.kind === 'info' ? view.title
              : ''}</Text>
          </Box>
        )}

        {/* overlay 在输入框下方展开——视觉上和输入框一体 */}
        {view.kind === 'permission' && <PermissionOverlay view={view} />}
        {view.kind === 'menu' && <MenuOverlay view={view} />}
        {view.kind === 'skills' && <SkillsPanel view={view} />}
        {view.kind === 'mcp' && <McpPanel view={view} />}
        {view.kind === 'form' && <FormPanel view={view} />}
        {view.kind === 'sessionPicker' && <SessionPickerOverlay view={view} cwd={currentCwdRef.current} />}
        {view.kind === 'config' && <ConfigOverlay view={view} entries={configEntries} />}
        {view.kind === 'info' && <InfoOverlay view={view} scroll={infoScroll} />}
      </Box>

      {/* StatusBar 始终在动态区底部 */}
      <StatusBar
        state={chat.status}
        provider={statusBarData.provider}
        model={statusBarData.model}
        sessionId={statusBarData.sessionId}
        title={statusBarData.title}
        tokens={statusBarData.tokens}
        windowTokens={statusBarData.windowTokens}
        usage={statusBarData.usage}
        cwd={statusBarData.cwd}
      />
    </>
  )
}
