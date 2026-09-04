import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Static, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { AgentToUiMessage, PermissionDecision, Config, UiPort } from '@dogegg/bridge'
import { TopBar, MessageBlock, StatusBar, ListPicker, MultilineInput } from '../components'
import { palette, onThemeChange } from '../theme'
import { renderMarkdown } from '../markdown'
import { clearScreen, resetSigintTimer } from './entry'
import { reducer, type ChatState, type Block } from '../chat'
import { parseCommand, matchCommands } from '../input'
import { buildEntries, entryLabel, parentPath, type TreeCtx } from '../overlays/config'
import { type View } from './view-state'

const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']

// Static items 的类型：首项是品牌头（启动打印一次），其余是已完成的消息块。
type StaticItem = { type: 'header' } | { type: 'block'; block: Block }

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
// 架构（Claude Code 式）：已完成的消息块经 <Static> 打印进终端滚动缓冲区，
// 用户用终端原生滚动查看历史；Ink 只重绘底部动态区（未完成块+流式+输入+状态栏）。
export function App({ port }: { port: UiPort }) {
  const [chat, dispatch] = useReducer(reducer, { blocks: [], status: 'idle', partial: null, toolActive: false } as ChatState)
  const [view, setViewState] = useState<View>({ kind: 'none' })
  const [input, setInput] = useState('')
  const [configSnapshot, setConfigSnapshot] = useState<Config | null>(null)
  const [suggestCursor, setSuggestCursorState] = useState<number | null>(null) // 联想提示选中索引（null=未选中）
  const suggestCursorRef = useRef<number | null>(null) // 镜像供 handleSubmit 读取（闭包防过期）
  const setSuggestCursor = useCallback((c: number | null) => { suggestCursorRef.current = c; setSuggestCursorState(c) }, [])
  const [infoScroll, setInfoScroll] = useState(0) // info overlay 独立翻页
  const [statusBarData, setStatusBarData] = useState<{ provider?: string; model?: string; sessionId?: string; tokens?: number; windowTokens?: number; cwd?: string }>({})
  const currentCwdRef = useRef<string>('')
  // 标记是否为显式信息请求（/context /status 等），用于区分轮询的静默更新。
  const explicitInfoRef = useRef(false)
  // Static 重挂载 key——会话切换/清空时清屏重绘。
  const [staticKey, setStaticKey] = useState(0)
  // 主题状态：切换主题时触发重渲染（palette 通过 Proxy 动态读取）。
  const [, setThemeTick] = useState(0)
  useEffect(() => onThemeChange(() => setThemeTick((t) => t + 1)), [])
  const inputHistoryRef = useRef<string[]>([])
  const historyCursorRef = useRef<number>(-1) // 输入历史游标（-1=未在浏览历史）
  // view/config 用 ref 镜像，避免 Ink useInput 回调闭包过期（useState 在回调里拿到的是旧值）。
  const viewRef = useRef<View>(view)
  const configRef = useRef<Config | null>(null)
  const configIntent = useRef<'model' | 'config' | null>(null)
  const suppressEnterRef = useRef(false)
  const statusRef = useRef(chat.status) // 镜像 chat.status 供 useInput 读取（闭包防过期）

  const setView = useCallback((v: View) => { viewRef.current = v; setViewState(v) }, [])
  const updateConfig = useCallback((c: Config) => { configRef.current = c; setConfigSnapshot(c) }, [])
  const openMenu = useCallback((title: string, items: { label: string; onSelect: () => void }[]) => setView({ kind: 'menu', title, items, cursor: 0 }), [setView])

  useEffect(() => { statusRef.current = chat.status }, [chat.status])

  // 运行中轮询 context_request（2s 间隔）——让 StatusBar 的 tokens 实时更新。
  useEffect(() => {
    const running = chat.status !== 'idle' && chat.status !== 'finished' && chat.status !== 'cancelled' && chat.status !== 'error'
    if (!running) return
    const timer = setInterval(() => port.post({ type: 'context_request' }), 2000)
    return () => clearInterval(timer)
  }, [port, chat.status])

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
      // 会话切换/清空：清屏 + Static 重挂载（Static 已输出的内容无法撤回）。
      if (msg.type === 'session_ready' || msg.type === 'history_cleared') {
        clearScreen()
        setStaticKey((k) => k + 1)
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
    if (key.ctrl && inputChar === 'c') {
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
        if ((entry.kind === 'goto' || entry.kind === 'action') && entry.del) {
          entry.del()
          setView({ ...v, cursor: Math.min(v.cursor, Math.max(0, entries.length - 2)), preview: null })
        }
      }
    } else if (v.kind === 'none') {
      // 斜杠命令联想提示：输入以 / 开头且有匹配时，↑↓ 选择、回车/Tab 补全。
      const matches = matchCommands(input)
      if (matches.length > 0) {
        if (key.upArrow) { setSuggestCursor(suggestCursorRef.current === null ? matches.length - 1 : (suggestCursorRef.current - 1 + matches.length) % matches.length); return }
        if (key.downArrow) { setSuggestCursor(suggestCursorRef.current === null ? 0 : (suggestCursorRef.current + 1) % matches.length); return }
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
      // ↑/↓ 召回输入历史。
      if (key.upArrow) {
        const history = inputHistoryRef.current
        if (history.length === 0) return
        const next = historyCursorRef.current < 0 ? history.length - 1 : Math.max(0, historyCursorRef.current - 1)
        historyCursorRef.current = next
        setInput(history[next] ?? '')
      } else if (key.downArrow) {
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
      // 信息面板：esc 关闭，↑/↓ 翻页（固定 15 行窗口）。
      const page = 10
      if (key.escape) { setView({ kind: 'none' }) }
      else if (key.upArrow) setInfoScroll((s) => Math.min(s + page, Math.max(0, v.lines.length - 1)))
      else if (key.downArrow) setInfoScroll((s) => Math.max(0, s - page))
    }
  })

  const handleSubmit = (raw: string) => {
    // 联想补全拦截：有联想匹配且选中了项时，回车补全到输入框而非提交。
    const matches = matchCommands(raw)
    if (matches.length > 0 && suggestCursorRef.current !== null) {
      setInput(matches[suggestCursorRef.current]!.cmd)
      setSuggestCursor(null)
      return
    }
    const result = parseCommand(raw)
    if (result.kind === 'user' && !result.text) return
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
        const cmd = raw.trim().split(/\s+/)[0]
        configIntent.current = cmd === '/model' ? 'model' : 'config'
      }
      // 显式信息请求标记：/context /status /tools /system /log 会回 info overlay。
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

  // ── 渲染 ──
  const configEntries = view.kind === 'config' && configSnapshot ? buildEntries(configSnapshot, view.path, treeCtx) : []
  const suggestMatches = view.kind === 'none' ? matchCommands(input) : []

  const headerInfo = configSnapshot
    ? (configSnapshot.defaultProvider ? `${configSnapshot.defaultProvider}/${configSnapshot.defaultModel ?? '?'}` : '未配置 provider（请先 /config）')
    : '加载配置中…'

  // Static items：品牌头 + 已完成的块（toolActive 时最后一块未完成，留在动态区）。
  const stableCount = chat.toolActive && chat.blocks.length > 0 ? chat.blocks.length - 1 : chat.blocks.length
  const staticItems: StaticItem[] = [
    { type: 'header' },
    ...chat.blocks.slice(0, stableCount).map((block) => ({ type: 'block' as const, block })),
  ]

  // 动态区：未完成的 tool 块（会再更新）+ 流式 partial。
  const activeBlocks = chat.toolActive ? chat.blocks.slice(stableCount) : []

  return (
    <>
      {/* Static：已完成的块打印进终端缓冲区，永不重绘；用户用终端原生滚动查看历史 */}
      <Static key={staticKey} items={staticItems}>
        {(item, index) => {
          if (item.type === 'header') return <TopBar key="header" info={headerInfo} />
          // 块渲染前完成 markdown → 纯文本转换（Static 只渲染一次，无性能问题）。
          const isMd = item.block.kind === 'assistant' || item.block.kind === 'thinking'
          const block: Block = isMd
            ? {
                ...item.block,
                text: renderMarkdown(item.block.text),
                ...(item.block.full !== undefined ? { full: renderMarkdown(item.block.full) } : {}),
              }
            : item.block
          return <MessageBlock key={index} block={block} />
        }}
      </Static>

      {/* 动态区：未完成块 + 流式 partial + 输入 + overlay + 状态栏，由 Ink 重绘 */}
      <Box flexDirection="column">
        {activeBlocks.map((b) => (
          <MessageBlock key={b.toolId ?? 'active'} block={b} />
        ))}
        {chat.partial ? (
          <Box flexDirection="column" marginBottom={1}>
            {chat.partial.kind === 'thinking' ? (
              <Text dimColor>{chat.partial.text}</Text>
            ) : (
              <Text>{renderMarkdown(chat.partial.text)}</Text>
            )}
          </Box>
        ) : null}

        {view.kind === 'none' && (
          <Box flexDirection="column">
            {suggestMatches.length > 0 && (
              <Box flexDirection="column">
                {suggestMatches.map((m, i) => (
                  <Text key={m.cmd} inverse={i === suggestCursor} color={i === suggestCursor ? undefined : palette.subtext}>
                    {i === suggestCursor ? '> ' : '  '}{m.cmd} <Text dimColor>{m.desc}</Text>
                  </Text>
                ))}
              </Box>
            )}
            <Box>
              <Text color={palette.accent}>{'> '}</Text>
              <MultilineInput value={input} onChange={(v) => { setInput(v); setSuggestCursor(null) }} onSubmit={handleSubmit} />
            </Box>
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
        {view.kind === 'permission' && (() => {
          // diff 预览：edit_file 显示 old→new，write_file 显示要写入的内容
          const inp = view.input as Record<string, unknown> | null
          return (
          <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1}>
            <Text bold color={palette.accent}>工具 {view.tool} 请求权限</Text>
            {view.tool === 'edit_file' && inp && (
              <Box flexDirection="column">
                <Text dimColor>文件：{String(inp.path ?? '')}</Text>
                <Text color={palette.red}>- {String(inp.old_string ?? '').slice(0, 200)}</Text>
                <Text color={palette.green}>+ {String(inp.new_string ?? '').slice(0, 200)}</Text>
              </Box>
            )}
            {view.tool === 'write_file' && inp && (
              <Box flexDirection="column">
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
          // 窗口化：最多显示 12 项，cursor 靠边时滚动。
          const WIN = 12
          const start = Math.max(0, Math.min(view.cursor - WIN + 3, Math.max(0, filtered.length - WIN)))
          const windowed = filtered.slice(start, start + WIN)
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={palette.subtext} paddingX={1}>
              <Text bold color={palette.accent}>选择会话 — {dirName || '当前目录'}</Text>
              <Text dimColor>搜索: {view.query || '（输入过滤）'}{'_'}</Text>
              {windowed.length === 0 ? (
                <Text dimColor>（无匹配会话）</Text>
              ) : (
                windowed.map((s, i) => {
                  const realIdx = start + i
                  return (
                    <Text key={s.id} inverse={realIdx === view.cursor}>{realIdx === view.cursor ? '> ' : '  '}{s.preview} <Text dimColor>{relTime(s.updatedAt)}</Text></Text>
                  )
                })
              )}
              {filtered.length > WIN && <Text dimColor>（{filtered.length} 项，↑↓ 滚动）</Text>}
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
        {view.kind === 'info' && (() => {
          // 固定 15 行窗口 + infoScroll 翻页。
          const WIN = 15
          const start = Math.max(0, view.lines.length - infoScroll - WIN)
          const windowed = view.lines.slice(start, start + WIN)
          return (
            <Box flexDirection="column" borderStyle="round" borderColor="#6c7086" paddingX={1}>
              <Text bold color="#89b4fa">{view.title}</Text>
              {windowed.map((line, i) => (
                <Text key={i} dimColor={line.startsWith('─') || line.startsWith('路径')}>{line}</Text>
              ))}
              <Text dimColor>↑↓ 翻页 · esc 关闭</Text>
            </Box>
          )
        })()}
      </Box>

      {/* StatusBar 始终在动态区底部 */}
      <StatusBar state={chat.status} provider={statusBarData.provider} model={statusBarData.model} sessionId={statusBarData.sessionId} tokens={statusBarData.tokens} windowTokens={statusBarData.windowTokens} cwd={statusBarData.cwd} />
    </>
  )
}
