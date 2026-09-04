import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { AgentToUiMessage, UiToAgentMessage, PermissionDecision, Config, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, ListPicker, MultilineInput } from '../components'
import { palette, THEMES, onThemeChange, setTheme, getCurrentTheme } from '../theme'
import type { BlockKind } from '../../shared'
import { isExpandable } from '../../shared'
import { renderMarkdown } from '../markdown'
import { resetSigintTimer } from './entry'
import { reducer, buildDisplayBlocks, estimateBlockLines, moveBrowse, toggleExpanded, type ChatState } from '../chat'
import { parseCommand, matchCommands } from '../input'
import { buildEntries, entryLabel, parentPath, type ConfigPath, type TreeCtx } from '../overlays/config'
import { type View } from './view-state'

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']

// 会话搜索过滤：按预览文本模糊匹配（大小写不敏感）。
function filterSessions(sessions: { id: string; preview: string; updatedAt: string }[], query: string): { id: string; preview: string; updatedAt: string }[] {
  if (!query) return sessions
  const q = query.toLowerCase()
  return sessions.filter((s) => s.preview.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
}

// 相对时间格式化：now/m/h/d。
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  return `${d}天前`
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
  // 标记是否为显式信息请求（/context /status 等），用于区分轮询的静默更新。
  const explicitInfoRef = useRef(false)
  // 主题状态：切换主题时触发重渲染（palette 通过 Proxy 动态读取）。
  const [, setThemeTick] = useState(0)
  useEffect(() => onThemeChange(() => setThemeTick((t) => t + 1)), [])
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

  const [termDims, setTermDims] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 })

  // 终端 resize 时重渲染——Ink 的 useStdout 不会自动触发 React 更新。
  useEffect(() => {
    const handler = () => setTermDims({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
    stdout.on('resize', handler)
    return () => { stdout.off('resize', handler) }
  }, [stdout])

  const setBrowseBoth = useCallback((i: number | null) => { browseRef.current = i; setBrowse(i) }, [])
  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const updateConfig = useCallback((c: Config) => { configRef.current = c; setConfigSnapshot(c) }, [])
  const openMenu = useCallback((title: string, items: { label: string; onSelect: () => void }[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])

  useEffect(() => { blocksRef.current = chat.blocks }, [chat.blocks])
  useEffect(() => { statusRef.current = chat.status }, [chat.status])

  // 用户手动滚动标记——PageUp 设为 true，新消息到达时如果未手动滚则保持底部。
  const userScrolledRef = useRef(false)
  const prevBlocksLenRef = useRef(0)
  useEffect(() => {
    // 新消息块到达时（长度变化），如果用户没手动向上滚，保持底部（scroll=0）。
    if (chat.blocks.length !== prevBlocksLenRef.current) {
      prevBlocksLenRef.current = chat.blocks.length
      if (!userScrolledRef.current) setScroll(0)
    }
  }, [chat.blocks.length])

  // 流式 partial 增长时，如果用户没手动向上滚，保持底部（scroll=0）。
  // partial 更新频繁，确保新内容始终可见在底部。
  useEffect(() => {
    if (!userScrolledRef.current) setScroll(0)
  }, [chat.partial])

  // 运行中轮询 context_request（3s 间隔）——让 StatusBar 的 tokens 实时更新。
  // 与 WebUI InfoPanel 的 3s 轮询一致；非运行态停止避免无效请求。
  useEffect(() => {
    const running = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'
    if (!running) return
    const timer = setInterval(() => port.post({ type: 'context_request' }), 2000)
    return () => clearInterval(timer)
  }, [port, chat.status])

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
        userScrolledRef.current = false
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
        // 路径归一化：统一为小写 + 正斜杠，兼容 Windows 反斜杠 + 大小写不敏感。
        const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const cwd = normalize(currentCwdRef.current)
        const filtered = msg.sessions.filter((s) => normalize(s.cwd ?? '') === cwd)
        setView({ kind: 'sessionPicker', sessions: filtered.map((s) => ({ id: s.id, preview: s.preview || '（空会话）', updatedAt: s.updatedAt })), cursor: 0, query: '' })
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
        // 仅显式请求（/status）时打开 info overlay；启动时的自动请求静默更新。
        if (explicitInfoRef.current) {
          explicitInfoRef.current = false
          setInfoScroll(0); setView({ kind: 'info', title: '状态', lines: [
            `session   ${msg.sessionId}`,
            `provider  ${msg.provider}`,
            `model     ${msg.model}`,
            `cwd       ${msg.cwd}`,
            `state     ${msg.state}`,
            `context   ${msg.estimatedTokens} / ${msg.windowTokens}`,
          ] })
        }
      } else if (msg.type === 'context_state') {
        setStatusBarData((d) => ({ ...d, tokens: msg.estimatedTokens, windowTokens: msg.windowTokens }))
        // 仅显式请求（/context）时打开 info overlay；轮询静默更新 StatusBar。
        if (explicitInfoRef.current) {
          explicitInfoRef.current = false
          setInfoScroll(0); setView({ kind: 'info', title: '上下文', lines: [
            `${msg.estimatedTokens} / ${msg.windowTokens} tokens（${msg.percent}%）`,
            `压缩阈值：窗口 80% = ${Math.round(msg.windowTokens * 0.8)}`,
          ] })
        }
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
    // 订阅后主动取一次配置 + 状态，用于顶部品牌头和 CWD 过滤。
    port.post({ type: 'config_request' })
    port.post({ type: 'status_request' })
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
          // 操作后的导航行为：
          // - 有 del 的 action（按 Enter 删除）：返回父层（项已删，不留空页）
          // - 无 del 的 action（选择/添加）：留在同页，cursor 不变
          if (entry.del) {
            setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null })
          }
        }
      } else if (key.escape) {
        const parent = parentPath(v.path)
        if (parent) setView({ kind: 'config', path: parent, cursor: 0, preview: null })
        else setView({ kind: 'none' })
      } else if (inputChar === 'd' && entry) {
        // d 键删除：执行 del 后留在同页，clamp cursor 防越界（删最后一项时 cursor 回退）。
        if (entry.kind === 'goto' && entry.del) {
          entry.del()
          setView({ ...v, cursor: Math.min(v.cursor, Math.max(0, entries.length - 2)), preview: null })
        } else if (entry.kind === 'action' && entry.del) {
          entry.del()
          setView({ ...v, cursor: Math.min(v.cursor, Math.max(0, entries.length - 2)), preview: null })
        }
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
      // 块导航模式：Ctrl+Up/Ctrl+Down 在所有消息块间导航聚焦。
      // 所有块都能被选中聚焦，只有 thinking/tool 块能 Enter 展开。
      if (key.ctrl && key.upArrow && blocksRef.current.length > 0) {
        setBrowseBoth(moveBrowse(blocksRef.current, browseRef.current, true))
        return
      }
      if (key.ctrl && key.downArrow && blocksRef.current.length > 0) {
        setBrowseBoth(moveBrowse(blocksRef.current, browseRef.current, false))
        return
      }
      // Enter：在块导航模式下展开/折叠当前聚焦块（仅 thinking/tool 块有效）。
      // Ctrl+Enter 在终端中不可靠（发送 \n 被解析为普通 Enter，ctrl 丢失），故用 Enter。
      // 块导航模式下输入框无焦点，Enter 不会提交消息，不冲突。
      if (key.return && browseRef.current !== null) {
        const block = blocksRef.current[browseRef.current]
        if (block && isExpandable(block)) {
          const next = toggleExpanded(expandedRef.current, browseRef.current)
          expandedRef.current = next
          setExpanded(next)
        }
        return
      }
      // Escape：退出块导航模式，焦点回到输入框。
      if (key.escape && browseRef.current !== null) { setBrowseBoth(null); return }
      // 消息滚动用 PageUp/PageDown（步长 = 终端高度的 1/3，平滑滚动）。
      const scrollStep = Math.max(3, Math.floor(termDims.rows / 3))
      if (key.pageUp) { userScrolledRef.current = true; setScroll((s) => s + scrollStep) }
      else if (key.pageDown) {
        setScroll((s) => {
          const next = Math.max(0, s - scrollStep)
          if (next === 0) userScrolledRef.current = false // 滚到底部，清除标记
          return next
        })
      }
      // ↑/↓ 召回输入历史（只在未进入块导航模式时生效）。
      else if (key.upArrow && browseRef.current === null) {
        // 输入历史召回：↑ 向上（更早的输入），↓ 向下（更新的输入），到底部清空。
        const history = inputHistoryRef.current
        if (history.length === 0) return
        const next = historyCursorRef.current < 0 ? history.length - 1 : Math.max(0, historyCursorRef.current - 1)
        historyCursorRef.current = next
        setInput(history[next] ?? '')
      } else if (key.downArrow && browseRef.current === null) {
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
      // 显式信息请求标记：/context /status /tools /system /log 会回 info overlay。
      // 区分轮询的静默更新（3s context_request 不开 overlay）。
      if (['context_request', 'status_request', 'tools_request', 'system_request', 'log_request'].includes(result.msg.type)) {
        explicitInfoRef.current = true
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
  const termWidth = termDims.cols
  const termHeight = termDims.rows

  // 联想匹配提取一次（渲染里多处用，避免重复调用）。
  const suggestMatches = view.kind === 'none' ? matchCommands(input) : []

  // 精确计算各区域占用行数：
  // TopBar: 内容1行 + marginBottom1行 = 2行
  // StatusBar: 1行
  // 输入区: none视图 = 输入框(1) + "Enter发送"提示(1) = 2行；有browse提示+1；有suggest列表+N+1
  //          overlay视图 = 输入行(1) + overlay内容(动态)
  const topBarLines = 2
  const statusBarLines = 1
  let inputAreaLines = 2 // 输入框 + Enter提示
  if (view.kind === 'none') {
    if (browse !== null) inputAreaLines++
    if (suggestMatches.length > 0) inputAreaLines += suggestMatches.length + 1
  } else if (view.kind === 'info') {
    inputAreaLines = 1 + Math.min(12, Math.max(4, view.lines.length + 2))
  } else {
    inputAreaLines = 6 // overlay 估算
  }

  // chat 可用高度 = 终端高度 - TopBar - 输入区 - StatusBar。
  // 用于块级裁切（决定保留哪些块）；实际渲染由 flexShrink + overflowY 兜底。
  const viewportHeight = Math.max(3, termHeight - topBarLines - inputAreaLines - statusBarLines)

  const headerInfo = configSnapshot
    ? (configSnapshot.defaultProvider ? `${configSnapshot.defaultProvider}/${configSnapshot.defaultModel ?? '?'}` : '未配置 provider（请先 /config）')
    : '加载配置中…'

  // markdown 渲染（助手/思考块）+ 展开/折叠状态 + 行数估算 + 滚动窗口裁切。
  // useMemo 缓存 renderedBlocks——chat.blocks 不变时不重复解析 markdown（流式时只 partial 变）。
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

  // 流式 partial 块也纳入视口裁切范围——否则它超出 viewportHeight 挤压其他组件。
  // 将 partial 转为临时 DisplayBlock 追加到 displayBlocks 末尾参与裁切。
  let blocksForViewport = displayBlocks
  if (chat.partial) {
    const partialText = chat.partial.kind === 'thinking' ? chat.partial.text : renderMarkdown(chat.partial.text)
    blocksForViewport = [...displayBlocks, {
      ...chat.partial,
      kind: chat.partial.kind === 'thinking' ? 'thinking' : 'assistant',
      color: chat.partial.kind === 'thinking' ? 'yellow' : 'text',
      index: displayBlocks.length,
      lines: estimateBlockLines(partialText, termWidth),
      shownText: partialText,
      isCollapsed: false,
    }]
  }

  // 滚动裁切：从底部保留块，丢弃顶部超出窗口的块。
  // scroll=0 时只保留能放进 viewportHeight 的最后几个块。
  // 保守策略：宁可少保留一个块（少显示旧内容），也不能多保留导致溢出裁切最新内容。
  const totalLines = blocksForViewport.reduce((n, b) => n + b.lines, 0)
  const maxScroll = Math.max(0, totalLines - viewportHeight)
  const scrolled = Math.min(scroll, maxScroll)
  const visibleBlocks: typeof blocksForViewport = []
  let accLines = 0
  const budget = viewportHeight - scrolled // 可见行数预算
  for (let i = blocksForViewport.length - 1; i >= 0; i--) {
    const b = blocksForViewport[i]!
    if (accLines + b.lines > budget) break // 超出预算就停——保守
    visibleBlocks.unshift(b)
    accLines += b.lines
  }

  return (
    <Box flexDirection="column" height={termHeight} padding={0}>
      <TopBar info={headerInfo} />

      {/* 消息视口：flexShrink=1 + minHeight=3 让它在空间不足时收缩而非挤压其他组件。
          正常 column 布局 + overflowY=hidden：块级裁切保证只渲染能放下的块。 */}
      <Box flexDirection="column" minHeight={3} flexShrink={1} overflowY="hidden">
        {chat.blocks.length === 0 && !chat.partial ? (
          <Box flexDirection="column" paddingY={1}>
            <Text color="#94e2d5">🐶🥚 欢迎使用 DogEggAgent</Text>
            <Text dimColor>输入任务开始对话，输入 /help 查看命令{configSnapshot && configSnapshot.providers.length === 0 ? '；首次请先 /config 配置 provider' : ''}</Text>
          </Box>
        ) : (
          visibleBlocks.map((b) => (
            <MessageBlock key={b.index} kind={b.kind} color={b.color} focused={browse === b.index}>
              {b.isCollapsed ? (
                <Text dimColor>{b.kind === 'thinking'
                  ? (browse === b.index ? '（思考已折叠 · 回车展开）' : '（思考已折叠）')
                  : (browse === b.index ? '（结果已折叠 · 回车展开）' : '（结果已折叠）')}</Text>
              ) : (
                <Text>{b.shownText}</Text>
              )}
            </MessageBlock>
          ))
        )}
      </Box>

      {/* 输入区 + overlay：flexShrink=0 固定高度不被压缩。 */}
      <Box flexDirection="column" flexShrink={0}>
        {/* 输入框行：始终显示。none 视图聚焦主输入，其他视图显示禁用态或 prompt 输入 */}
        {view.kind === 'none' && (
          <Box flexDirection="column">
            {browse !== null && <Text dimColor>Ctrl+↑↓ 切换块 · Enter 展开/折叠 · esc 返回输入</Text>}
            {/* 斜杠命令联想提示：输入 / 开头且有匹配时，显示列表供 ↑↓ 选择、回车/Tab 补全 */}
            {suggestMatches.length > 0 && (
              <Box flexDirection="column" marginTop={0}>
                {suggestMatches.map((m, i) => (
                  <Text key={m.cmd} inverse={i === suggestCursor} color={i === suggestCursor ? undefined : palette.subtext}>
                    {i === suggestCursor ? '> ' : '  '}{m.cmd} <Text dimColor>{m.desc}</Text>
                  </Text>
                ))}
                <Text dimColor>↑↓ 选择 · 回车/Tab 补全 · esc 取消</Text>
              </Box>
            )}
            <Box>
              <Text color="blue">› </Text>
              <MultilineInput value={input} onChange={(v) => { setInput(v); setSuggestCursor(null) }} onSubmit={handleSubmit} focus={browse === null} />
            </Box>
            <Text dimColor>Enter 发送 · Shift+Enter 换行</Text>
          </Box>
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
        {view.kind !== 'none' && view.kind !== 'prompt' && (
          <Box>
            <Text color="blue">› </Text>
            <Text dimColor>{view.kind === 'permission' ? '权限请求中…'
              : view.kind === 'menu' ? view.title
              : view.kind === 'sessionPicker' ? '选择会话'
              : view.kind === 'config' ? `配置 / ${view.path.kind}`
              : view.kind === 'info' ? view.title
              : ''}</Text>
          </Box>
        )}

        {/* overlay 在输入框下方展开——视觉上和输入框一体 */}
        {view.kind === 'permission' && (() => {
          // diff 预览：edit_file 显示 old→new，write_file 显示要写入的内容
          const inp = view.input as Record<string, unknown> | null
          return (
          <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginTop={0}>
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
            <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1} marginTop={0}>
              <Text bold color={palette.accent}>选择会话 — {dirName || '当前目录'}</Text>
              <Text dimColor>搜索: {view.query || '（输入过滤）'}{'_'}</Text>
            {filtered.length === 0 ? (
              <Text dimColor>（无匹配会话）</Text>
            ) : (
              filtered.map((s, i) => (
                <Text key={s.id} inverse={i === view.cursor}>{i === view.cursor ? '> ' : '  '}{s.preview} <Text dimColor>{relTime(s.updatedAt)}</Text></Text>
              ))
            )}
              <Text dimColor>↑↓ 选择 · 回车切换 · d 删除 · esc 返回</Text>
            </Box>
          )
        })()}
        {view.kind === 'config' && (
          <ListPicker
            title={`配置 / ${view.path.kind}`}
            items={configEntries.map((e, i) => entryLabel(e, i === view.cursor && e.kind === 'bool' ? (view.preview ?? e.value) : undefined))}
            cursor={view.cursor}
            hint="↑↓ 选择 · 回车钻入/编辑 · ←→ 切布尔 · d 删 · esc 返回"
          />
        )}
        {view.kind === 'info' && (
          <Box flexDirection="column" borderStyle="round" borderColor="#6c7086" paddingX={1} marginTop={0}>
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
      </Box>

      {/* StatusBar 始终在底部——flexShrink=0 不被压缩。 */}
      <Box flexShrink={0}>
        <StatusBar state={chat.status} provider={statusBarData.provider} model={statusBarData.model} sessionId={statusBarData.sessionId} tokens={statusBarData.tokens} windowTokens={statusBarData.windowTokens} cwd={statusBarData.cwd} />
      </Box>
    </Box>
  )
}
