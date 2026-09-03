import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { AgentToUiMessage, UiToAgentMessage, PermissionDecision, Config, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, ListPicker } from '../components'
import { palette } from '../theme'
import type { BlockKind } from '../../shared'
import { renderMarkdown } from '../markdown'
import { resetSigintTimer } from './entry'
import { reducer, buildDisplayBlocks, sliceViewport, expandableIndices, moveBrowse, toggleExpanded, type ChatState } from '../chat'
import { parseCommand, matchCommands } from '../input'
import { buildEntries, entryLabel, parentPath, type ConfigPath, type TreeCtx } from '../overlays/config'
import { type View } from './view-state'

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']

// 会话搜索过滤：按预览文本模糊匹配（大小写不敏感）。
function filterSessions(sessions: { id: string; preview: string }[], query: string): { id: string; preview: string }[] {
  if (!query) return sessions
  const q = query.toLowerCase()
  return sessions.filter((s) => s.preview.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
}

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
  const [suggestCursor, setSuggestCursorState] = useState<number | null>(null) // 联想提示选中索引（null=未选中）
  const suggestCursorRef = useRef<number | null>(null) // 镜像供 handleSubmit 读取（闭包防过期）
  const setSuggestCursor = useCallback((c: number | null) => { suggestCursorRef.current = c; setSuggestCursorState(c) }, [])
  const [infoScroll, setInfoScroll] = useState(0) // info overlay 独立滚动（不与 chat scroll 共用）
  const [statusBarData, setStatusBarData] = useState<{ provider?: string; model?: string; sessionId?: string; tokens?: number; windowTokens?: number; cwd?: string }>({})
  const currentCwdRef = useRef<string>('')
  const [inputHistory] = useState<string[]>([])
  const inputHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef<number>(-1) // 输入历史游标（-1=未在浏览历史）
  // view/config 用 ref 镜像，避免 Ink useInput 回调闭包过期（useState 在回调里拿到的是旧值）。
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  const configIntent = useRef<'model' | 'config' | null>(null)
  const suppressEnterRef = useRef(false)
  const browseRef = useRef<number | null>(null)
  const expandedRef = useRef<Set<number>>(new Set())
  const blocksRef = useRef(chat.blocks)
  const statusRef = useRef(chat.status) // 镜像 chat.status 供 useInput 读取（闭包防过期）

  const setBrowseBoth = useCallback((i: number | null) => { browseRef.current = i; setBrowse(i) }, [])
  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const updateConfig = useCallback((c: Config) => { configRef.current = c; setConfigSnapshot(c) }, [])
  const openMenu = useCallback((title: string, items: { label: string; onSelect: () => void }[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])

  useEffect(() => { blocksRef.current = chat.blocks }, [chat.blocks])
  useEffect(() => { statusRef.current = chat.status }, [chat.status])

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
      // 会话切换/清空时重置 browse/expanded/scroll，避免旧会话的 index 泄漏到新会话。
      if (msg.type === 'session_ready' || msg.type === 'history_cleared') {
        setBrowseBoth(null)
        expandedRef.current = new Set()
        setExpanded(new Set())
        setScroll(0)
        setSuggestCursor(null)
      }
      // 错误恢复：error 时自动预填上次提交的文本到输入框，用户可直接改或重新提交。
      if (msg.type === 'error' && inputHistoryRef.current.length > 0) {
        const lastText = inputHistoryRef.current[inputHistoryRef.current.length - 1]!
        setInput(lastText)
        historyCursorRef.current = -1
      }
      if (msg.type === 'permission_request') {
        setView({ kind: 'permission', id: msg.id, tool: msg.tool, input: msg.input, cursor: 0 })
      } else if (msg.type === 'state' && msg.to !== 'waiting_permission' && viewRef.current.kind === 'permission') {
        // 权限等待期间状态离开 waiting_permission（如 cancel）→ 关闭 permission overlay。
        setView({ kind: 'none' })
      } else if (msg.type === 'session_list') {
        // 按 cwd 过滤：只显示当前工作目录下的会话（Claude 式——每个目录独立）。
        const filtered = msg.sessions.filter((s) => (s.cwd ?? '') === currentCwdRef.current)
        setView({ kind: 'sessionPicker', sessions: filtered.map((s) => ({ id: s.id, preview: s.preview })), cursor: 0, query: '' })
      } else if (msg.type === 'session_deleted') {
        // 会话删除后刷新列表——重新请求 session_list（会触发 sessionPicker 重建）。
        port.post({ type: 'list_sessions' })
      } else if (msg.type === 'config_state') {
        updateConfig(msg.config)
        if (configIntent.current === 'model') { openModelPicker(msg.config); configIntent.current = null }
        else if (configIntent.current === 'config') { openConfigTree(msg.config); configIntent.current = null }
      } else if (msg.type === 'config_updated') {
        updateConfig(msg.config)
      } else if (msg.type === 'tools_list') {
        setInfoScroll(0); setView({ kind: 'info', title: '工具', lines: msg.tools.map((t) => `${t.name} — ${t.description}`) })
      } else if (msg.type === 'status_state') {
        currentCwdRef.current = msg.cwd
        setStatusBarData({ provider: msg.provider, model: msg.model, sessionId: msg.sessionId, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens, cwd: msg.cwd })
        setInfoScroll(0); setView({ kind: 'info', title: '状态', lines: [
          `session   ${msg.sessionId}`,
          `provider  ${msg.provider}`,
          `model     ${msg.model}`,
          `cwd       ${msg.cwd}`,
          `state     ${msg.state}`,
          `context   ${msg.estimatedTokens} / ${msg.windowTokens}`,
        ] })
      } else if (msg.type === 'context_state') {
        setStatusBarData((d) => ({ ...d, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens }))
        setInfoScroll(0); setView({ kind: 'info', title: '上下文', lines: [
          `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`,
          `压缩阈值：窗口 80% = ${Math.round(msg.windowTokens * 0.8)}`,
        ] })
      } else if (msg.type === 'system_state') {
        setInfoScroll(0); setView({ kind: 'info', title: 'system prompt', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.content] })
      } else if (msg.type === 'compaction') {
        if (msg.source === 'manual') {
          setInfoScroll(0)
          setView({ kind: 'info', title: '压缩上下文', lines: [`压缩前：${msg.before_tokens} tokens`, `压缩后：${msg.after_tokens} tokens`] })
        }
      } else if (msg.type === 'permissions_list') {
        // /permissions：用 menu overlay 显示当前会话的 allow_always 授权列表。
        // 选中某项发 permission_revoke 撤销；列表为空时显示提示。
        if (msg.tools.length === 0) {
          setInfoScroll(0)
          setView({ kind: 'info', title: '会话权限', lines: ['当前会话没有 allow_always 授权的工具', '（选择权限弹层时选「始终允许」才会出现在这里）'] })
        } else {
          openMenu('会话权限（回车撤销授权）', msg.tools.map((t) => ({
            label: `${t}  （回车撤销）`,
            onSelect: () => { port.post({ type: 'permission_revoke', tool: t }) },
          })))
        }
      } else if (msg.type === 'log_state') {
        setInfoScroll(0); setView({ kind: 'info', title: '调试日志', lines: [`路径：${msg.path}`, '─'.repeat(40), msg.tail] })
      }
    })
    // 订阅后主动取一次配置，用于顶部品牌头展示当前 provider/model。
    port.post({ type: 'config_request' })
    return off
  }, [port, openMenu, openModelPicker, openConfigTree, updateConfig, setView])

  // 键盘路由：按 view 类型分发到不同处理。
  useInput((inputChar, key) => {
    // Ctrl+C：全局拦截——优先级最高，覆盖所有 view 类型。
    // 运行中（chat.status 不是 idle/finished/cancelled/error）→ 发 cancel 打断当前操作，不退出。
    // 空闲 → 弹退出确认（和 /quit 一致）。
    // 兜底：如果 Ink 的 useInput 没收到（程序卡死），entry.tsx 的全局 SIGINT handler 走两次 Ctrl+C 强制退出。
    if (key.ctrl && inputChar === 'c') {
      // Ctrl+C 被 useInput 处理——重置 SIGINT 兜底计时器，避免"cancel 后再 Ctrl+C 跳过退出确认"。
      resetSigintTimer()
      const status = statusRef.current
      const running = status !== 'idle' && status !== 'finished' && status !== 'cancelled' && status !== 'error'
      if (running) {
        port.post({ type: 'cancel' })
      } else if (viewRef.current.kind !== 'menu') {
        // 空闲且没在菜单里 → 弹退出确认（和 /quit 一致）
        suppressEnterRef.current = true
        queueMicrotask(() => { suppressEnterRef.current = false })
        setView({ kind: 'menu', title: '退出 DogEggAgent？', items: [
          { label: '确认退出', onSelect: () => { port.post({ type: 'quit' }); setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => setView({ kind: 'none' }) },
        ], cursor: 0 })
      }
      return
    }
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
    } else if (v.kind === 'prompt') {
      // prompt（标量输入）的 Esc：返回 config 编辑器原位（而非无法退出）。
      if (key.escape) setView({ kind: 'config', path: v.returnPath ?? { kind: 'root' }, cursor: v.returnCursor ?? 0, preview: null })
    } else if (v.kind === 'sessionPicker') {
      // 会话选择器：搜索过滤 + ↑↓ 导航 + 回车切换 + d 删除 + esc 返回。
      if (key.escape) { setView({ kind: 'none' }) }
      else if (key.return) {
        const filtered = filterSessions(v.sessions, v.query)
        const s = filtered[v.cursor]
        if (s) { port.post({ type: 'resume_session', id: s.id }); setView({ kind: 'none' }) }
      } else if (key.upArrow) {
        const filtered = filterSessions(v.sessions, v.query)
        setView({ ...v, cursor: (v.cursor + filtered.length - 1) % Math.max(1, filtered.length) })
      } else if (key.downArrow) {
        const filtered = filterSessions(v.sessions, v.query)
        setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, filtered.length) })
      } else if (inputChar === 'd' && v.query === '') {
        // d 键删除当前选中会话（仅在未搜索时生效——避免输入 d 搜索时误触发）。
        const filtered = filterSessions(v.sessions, v.query)
        const s = filtered[v.cursor]
        if (s) {
          suppressEnterRef.current = true
          queueMicrotask(() => { suppressEnterRef.current = false })
          setView({ kind: 'menu', title: `删除会话 ${s.id}？`, items: [
            { label: '确认删除', onSelect: () => { port.post({ type: 'delete_session', id: s.id }) } },
            { label: '取消', onSelect: () => setView({ kind: 'none' }) },
          ], cursor: 0 })
        }
      } else if (inputChar && !key.ctrl && !key.meta) {
        // 搜索输入：累积字符更新过滤
        if (inputChar === '\u007f' || inputChar === '\b') {
          // Backspace 删除最后一个搜索字符
          const newQuery = v.query.slice(0, -1)
          setView({ ...v, query: newQuery, cursor: 0 })
        } else if (inputChar >= ' ') {
          const newQuery = v.query + inputChar
          setView({ ...v, query: newQuery, cursor: 0 })
        }
      }
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
        else if (entry?.kind === 'scalar') setView({ kind: 'prompt', title: `输入 ${entry.label}`, value: entry.value, returnPath: v.path, returnCursor: v.cursor, onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'prompt') setView({ kind: 'prompt', title: entry.title, value: '', returnPath: v.path, returnCursor: v.cursor, onSubmit: (val) => { entry.save(val); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
        else if (entry?.kind === 'bool') { entry.save(v.preview ?? entry.value); setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) }
        else if (entry?.kind === 'action') {
          entry.run()
          // selectProvider/selectModel/selectShell 选中即设后自动回 root（不留在选择列表）。
          if (v.path.kind === 'selectProvider' || v.path.kind === 'selectModel' || v.path.kind === 'selectShell') {
            setView({ kind: 'config', path: { kind: 'root' }, cursor: 0, preview: null })
          }
        }
      } else if (key.escape) {
        const parent = parentPath(v.path)
        if (parent) setView({ kind: 'config', path: parent, cursor: 0, preview: null })
        else setView({ kind: 'none' })
      } else if (inputChar === 'd' && entry) {
        if (entry.kind === 'goto' && entry.del) { entry.del(); setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null }) }
        else if (entry.kind === 'action' && entry.del) { entry.del(); setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null }) }
      }
    } else if (v.kind === 'none') {
      // 斜杠命令联想提示：输入以 / 开头且有匹配时，↑↓ 选择、回车/Tab 补全。
      // 回车补全由 handleSubmit 拦截（TextInput 的 onSubmit 先于 useInput 触发），这里只处理 ↑↓ 和 Tab。
      const matches = matchCommands(input)
      if (matches.length > 0) {
        if (key.upArrow) { setSuggestCursor(suggestCursorRef.current === null ? matches.length - 1 : (suggestCursorRef.current - 1 + matches.length) % matches.length); return }
        if (key.downArrow) { setSuggestCursor(suggestCursorRef.current === null ? 0 : (suggestCursorRef.current + 1) % matches.length); return }
        // Tab 补全：选中项或唯一匹配。inputChar === '\t' 兜底 key.tab 不可靠的情况。
        if (key.tab || inputChar === '\t') {
          const idx = suggestCursorRef.current ?? (matches.length === 1 ? 0 : null)
          if (idx !== null) {
            setInput(matches[idx]!.cmd)
            setSuggestCursor(null)
          }
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
      // 消息滚动用 PageUp/PageDown；无可折叠块时 ↑/↓ 召回输入历史。
      const page = Math.max(5, Math.floor((stdout.rows || 24) / 2))
      if (key.pageUp) setScroll((s) => s + page)
      else if (key.pageDown) setScroll((s) => Math.max(0, s - page))
      else if (key.upArrow && expandable.length === 0 && browseRef.current === null) {
        // 输入历史召回：↑ 向上（更早的输入），↓ 向下（更新的输入），到底部清空。
        const history = inputHistoryRef.current
        if (history.length === 0) return
        const next = historyCursorRef.current < 0 ? history.length - 1 : Math.max(0, historyCursorRef.current - 1)
        historyCursorRef.current = next
        setInput(history[next] ?? '')
      } else if (key.downArrow && expandable.length === 0 && browseRef.current === null) {
        const history = inputHistoryRef.current
        if (history.length === 0 || historyCursorRef.current < 0) return
        const next = historyCursorRef.current + 1
        if (next >= history.length) {
          // 到底部——清空输入框，退出历史浏览。
          historyCursorRef.current = -1
          setInput('')
        } else {
          historyCursorRef.current = next
          setInput(history[next] ?? '')
        }
      }
    } else if (v.kind === 'info') {
      // 信息面板：esc 关闭，↑/↓ 翻页（用独立 infoScroll，不污染 chat scroll）。
      const page = Math.max(3, Math.floor((stdout.rows || 24) / 3))
      if (key.escape) { setView({ kind: 'none' }) }
      else if (key.upArrow) setInfoScroll((s) => {
        const maxScroll = Math.max(0, (v.lines.length ?? 0) - (viewportHeight - 4))
        return Math.min(s + page, maxScroll)
      })
      else if (key.downArrow) setInfoScroll((s) => Math.max(0, s - page))
    }
  })

  const handleSubmit = (raw: string) => {
    // 联想补全拦截：有联想匹配且选中了项时，回车补全到输入框而非提交。
    // 用 ref 读 suggestCursor 防闭包过期；handleSubmit 由 TextInput 的 onSubmit 触发，可能先于 useInput。
    const matches = matchCommands(raw)
    if (matches.length > 0 && suggestCursorRef.current !== null) {
      setInput(matches[suggestCursorRef.current]!.cmd)
      setSuggestCursor(null)
      return
    }
    const result = parseCommand(raw)
    if (result.kind === 'user' && !result.text) return
    setScroll(0)
    if (result.kind === 'user') {
      dispatch({ type: 'local_user', text: result.text })
      inputHistoryRef.current.push(result.text)
      historyCursorRef.current = -1
      port.post({ type: 'submit', text: result.text })
    } else if (result.kind === 'help') {
      // /help 改为 info overlay 呈现命令列表，不再塞消息块。
      suppressEnterRef.current = true
      queueMicrotask(() => { suppressEnterRef.current = false })
      setInfoScroll(0)
      setView({ kind: 'info', title: '帮助', lines: [
        '/new 新建会话      /config 编辑配置',
        '/session 切换会话   /model 快速切模型',
        '/clear 清空历史     /compact 手动压缩',
        '/cd 切换工作目录    /context 查看占用',
        '/tools 列出工具     /system 系统提示词',
        '/status 状态一览    /log 调试日志',
        '/permissions 会话权限  /quit 退出',
        '/help 本帮助',
      ] })
    } else {
      // /clear 和 /quit 需确认弹层（不可逆操作）。
      if (result.msg.type === 'clear_history') {
        suppressEnterRef.current = true
        queueMicrotask(() => { suppressEnterRef.current = false })
        openMenu('清空当前会话历史？此操作不可撤销。', [
          { label: '确认清空', onSelect: () => { port.post({ type: 'clear_history' }); setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => setView({ kind: 'none' }) },
        ])
        setInput('')
        return
      }
      if (result.msg.type === 'quit') {
        suppressEnterRef.current = true
        queueMicrotask(() => { suppressEnterRef.current = false })
        openMenu('退出 DogEggAgent？', [
          { label: '确认退出', onSelect: () => { port.post({ type: 'quit' }); setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => setView({ kind: 'none' }) },
        ])
        setInput('')
        return
      }
      // 命令消息：/model /config 需要 intent 标记（后端回 config_state 时据此打开对应 overlay）。
      if (result.msg.type === 'config_request') {
        // 从命令文本推断 intent（/model vs /config）
        const cmd = raw.trim().split(/\s+/)[0]
        configIntent.current = cmd === '/model' ? 'model' : 'config'
      }
      // 所有会打开 overlay 的命令统一吞掉提交回车——
      // port 是同步通道，agent 回响应可能立即设 view 为 menu/info，
      // 不吞的话同一个回车被 useInput 在新 view 里处理（误选中第一项）。
      suppressEnterRef.current = true
      queueMicrotask(() => { suppressEnterRef.current = false })
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
  // 联想匹配提取一次（渲染里多处用，避免重复调用）。
  // useMemo 缓存 renderedBlocks——chat.blocks 不变时不重复解析 markdown（流式时只 partial 变）。
  const suggestMatches = view.kind === 'none' ? matchCommands(input) : []
  const isMd = (kind: BlockKind) => kind === 'assistant' || kind === 'thinking'
  const renderedBlocks = useMemo(() =>
    chat.blocks.map((b) => ({
      ...b,
      text: isMd(b.kind) ? renderMarkdown(b.text) : b.text,
      full: b.full !== undefined ? (isMd(b.kind) ? renderMarkdown(b.full) : b.full) : undefined,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.blocks],
  )
  const displayBlocks = buildDisplayBlocks(renderedBlocks, expanded, termWidth)
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
            <MessageBlock key={b.index} kind={b.kind} color={b.color} focused={browse === b.index}>
              {b.isCollapsed ? (
                // 折叠状态：思考块和工具块各自显示折叠提示（选中时提示可展开）
                <Text dimColor>{b.kind === 'thinking'
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
            kind={chat.partial.kind === 'thinking' ? 'thinking' : 'assistant'}
            color={chat.partial.kind === 'thinking' ? 'yellow' : 'text'}
          >
            <Text dimColor={chat.partial.kind === 'thinking'}>{chat.partial.kind === 'thinking' ? chat.partial.text : renderMarkdown(chat.partial.text)}</Text>
          </MessageBlock>
        ) : null}
        {scrolled > 0 && (
          <Text dimColor>↑ {scrolled} 行历史（↑↓ 或 PageUp/PageDown 滚动）</Text>
        )}
      </Box>

      {view.kind === 'permission' && (() => {
        // diff 预览：edit_file 显示 old→new，write_file 显示要写入的内容
        const inp = view.input as Record<string, unknown> | null
        return (
        <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginY={1}>
          <Text bold color={palette.accent}>工具 {view.tool} 请求权限</Text>
          {view.tool === 'edit_file' && inp && (
            <Box flexDirection="column" marginTop={0}>
              <Text dimColor>文件：{String(inp.path ?? '')}</Text>
              <Text color={palette.red}>- {String(inp.old_string ?? '').slice(0, 200)}</Text>
              <Text color={palette.green}>+ {String(inp.new_string ?? '').slice(0, 200)}</Text>
            </Box>
          )}
          {view.tool === 'write_file' && inp && (
            <Box flexDirection="column" marginTop={0}>
              <Text dimColor>文件：{String(inp.path ?? '')}</Text>
              <Text color={palette.green} wrap="truncate">+ {String(inp.content ?? '').slice(0, 200)}</Text>
            </Box>
          )}
          {view.tool === 'shell' && inp && (
            <Text dimColor>命令：{String(inp.command ?? '')}</Text>
          )}
          {DECISION_LABELS.map((label, i) => (
            <Text key={label} inverse={i === view.cursor}>{i === view.cursor ? '> ' : '  '}{label}</Text>
          ))}
          <Text dimColor>↑↓ 选择 · 回车确认 · esc 拒绝</Text>
        </Box>
        )
      })()}
      {view.kind === 'menu' && (
        <ListPicker title={view.title} items={view.items.map((i) => i.label)} cursor={view.cursor} hint="↑↓ 选择 · 回车确认 · esc 返回" />
      )}
      {view.kind === 'sessionPicker' && (() => {
        const filtered = filterSessions(view.sessions, view.query)
        const dirName = currentCwdRef.current ? currentCwdRef.current.replace(/\\/g, '/').split('/').pop() ?? currentCwdRef.current : ''
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginY={1}>
            <Text bold color={palette.accent}>选择会话 — {dirName || '当前目录'}</Text>
            <Text dimColor>搜索: {view.query || '（输入过滤）'}{'_'}</Text>
            {filtered.length === 0 ? (
              <Text dimColor>（无匹配会话）</Text>
            ) : (
              filtered.map((s, i) => (
                <Text key={s.id} inverse={i === view.cursor}>{i === view.cursor ? '> ' : '  '}{s.preview}</Text>
              ))
            )}
            <Text dimColor>↑↓ 选择 · 回车切换 · d 删除 · esc 返回</Text>
          </Box>
        )
      })()}
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
            {/* 裁切可见窗口：infoScroll 为顶部隐藏行数，viewportHeight 控制可见行数 */}
            {view.lines
              .slice(Math.max(0, view.lines.length - infoScroll - (viewportHeight - 4)), Math.max(0, view.lines.length - infoScroll))
              .map((line, i) => (
                <Text key={i} dimColor={line.startsWith('─') || line.startsWith('路径')}>{line}</Text>
              ))}
          </Box>
          <Text dimColor>↑↓ 翻页 · esc 关闭</Text>
        </Box>
      )}

      {view.kind === 'none' && <StatusBar state={chat.status} provider={statusBarData.provider} model={statusBarData.model} sessionId={statusBarData.sessionId} tokens={statusBarData.tokens} windowTokens={statusBarData.windowTokens} cwd={statusBarData.cwd} />}
      {view.kind === 'none' && (
        <Box flexDirection="column">
          {browse !== null && <Text dimColor>↑↓ 切换块 · 回车展开/折叠 · esc 返回输入</Text>}
          {/* 斜杠命令联想提示：输入 / 开头且有匹配时，显示列表供 ↑↓ 选择、回车/Tab 补全 */}
          {suggestMatches.length > 0 && (
            <Box flexDirection="column" marginTop={0}>
              {suggestMatches.map((m, i) => (
                <Text key={m.cmd} inverse={i === suggestCursor} color={i === suggestCursor ? undefined : palette.subtext}>
                  {i === suggestCursor ? '> ' : '  '}{m.cmd} <Text dimColor>{m.desc}</Text>
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
