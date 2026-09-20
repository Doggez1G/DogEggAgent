import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Key } from 'ink'
import type { Config } from '@dogegg/bridge'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlePermissionKeys } from '../../src/tui/features/permission/keys'
import { handleMenuKeys } from '../../src/tui/features/menu/keys'
import { handleSessionPickerKeys } from '../../src/tui/features/sessions/keys'
import { handleConfigKeys } from '../../src/tui/features/config/keys'
import { handleSuggestionKeys, handleHistoryKeys, handlePathSuggestKeys } from '../../src/tui/features/input/keys'
import { handleBrowseKeys } from '../../src/tui/features/browse/keys'
import { handleInfoKeys } from '../../src/tui/features/info/keys'
import { filterSessions } from '../../src/tui/features/sessions/filter'
import { buildEntries } from '../../src/tui/features/config'

// key-routing 单测：每个特征的按键处理器注入 spy api，逐条验证「按键 → 副作用」。
// 这层是 TUI 回归最多的地方（cursor 边界 / esc 层级 / d 删除 clamp / 联想补全）。

beforeEach(() => { vi.clearAllMocks() })
const key = (p: Partial<Key>): Key => p as Key
const setView = vi.fn()
const post = vi.fn()
const api = { setView, post, suppressEnter: vi.fn() }

const permissionView = { kind: 'permission' as const, id: 'p1', tool: 'shell', input: null, cursor: 0 }

describe('handlePermissionKeys', () => {
  it('↑↓ 在三个决策项间循环', () => {
    handlePermissionKeys(permissionView, key({ upArrow: true }), api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 2 }))
    handlePermissionKeys({ ...permissionView, cursor: 2 }, key({ downArrow: true }), api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 0 }))
  })
  it('回车提交当前决策并关闭弹层', () => {
    handlePermissionKeys(permissionView, key({ return: true }), api)
    expect(post).toHaveBeenCalledWith({ type: 'permission_decision', id: 'p1', decision: 'allow_once' })
    expect(setView).toHaveBeenCalledWith({ kind: 'none' })
  })
  it('esc 视为拒绝', () => {
    handlePermissionKeys(permissionView, key({ escape: true }), api)
    expect(post).toHaveBeenCalledWith({ type: 'permission_decision', id: 'p1', decision: 'reject' })
  })
})

describe('handleMenuKeys', () => {
  const menuView = { kind: 'menu' as const, title: 't', items: [
    { label: 'a', onSelect: vi.fn() },
    { label: 'b', onSelect: vi.fn() },
  ], cursor: 0 }
  it('↑ 从 0 环绕到末项；回车执行选中项 onSelect', () => {
    handleMenuKeys(menuView, key({ upArrow: true }), api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 1 }))
    handleMenuKeys({ ...menuView, cursor: 1 }, key({ return: true }), api)
    expect(menuView.items[1]!.onSelect).toHaveBeenCalled()
  })
  it('esc 关闭菜单', () => {
    handleMenuKeys(menuView, key({ escape: true }), api)
    expect(setView).toHaveBeenCalledWith({ kind: 'none' })
  })
  it('空菜单防除零：↑ 保持 cursor 不崩', () => {
    handleMenuKeys({ ...menuView, items: [], cursor: 0 }, key({ upArrow: true }), api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 0 }))
  })
})

describe('handleSessionPickerKeys', () => {
  const sessions = [
    { id: 's1', preview: 'alpha 会话', updatedAt: '2026-09-07T10:00:00Z' },
    { id: 's2', preview: 'beta 会话', updatedAt: '2026-09-07T11:00:00Z' },
  ]
  const pickerView = { kind: 'sessionPicker' as const, sessions, cursor: 0, query: '' }
  it('回车 resume 过滤后的选中会话', () => {
    handleSessionPickerKeys(pickerView, key({ return: true }), '', api)
    expect(post).toHaveBeenCalledWith({ type: 'resume_session', id: 's1' })
  })
  it('输入字符累积到 query 并重置 cursor；退格删除', () => {
    handleSessionPickerKeys(pickerView, key({}), 'a', api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ query: 'a', cursor: 0 }))
    handleSessionPickerKeys({ ...pickerView, query: 'ab' }, key({}), '\u007f', api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ query: 'a', cursor: 0 }))
  })
  it('d 键仅在未搜索时打开删除确认菜单（吞回车）；确认后回选择器空壳再删除', () => {
    const suppressEnter = vi.fn()
    handleSessionPickerKeys(pickerView, key({}), 'd', { setView, post, suppressEnter })
    expect(suppressEnter).toHaveBeenCalled()
    const call = setView.mock.calls[0]![0]! as { kind: string; title: string; items: { label: string; onSelect: () => void }[] }
    expect(call.kind).toBe('menu')
    call.items[0]!.onSelect()
    // 空壳先于删除消息——session_list 响应只刷新已开的选择器（推送不弹层），删除后列表由此重建。
    expect(setView).toHaveBeenCalledWith({ kind: 'sessionPicker', sessions: [], cursor: 0, query: '' })
    expect(post).toHaveBeenCalledWith({ type: 'delete_session', id: 's1' })
  })
})

describe('handleConfigKeys', () => {
  // 最小配置：一个 provider 一个模型——root 层的 entries 数量由 buildEntries 决定。
  const cfg: Config = {
    defaultProvider: 'o', defaultModel: 'm', maxIterations: 50, maxRetries: 3,
    systemPrompt: undefined, shellProgram: undefined,
    permission: { allow: [], reject: [], ask: [] },
    providers: [{ name: 'o', protocol: 'openai', baseURL: 'http://x/v1', apiKey: 'k', models: [{ name: 'm' }] }],
  } as unknown as Config
  const configView = { kind: 'config' as const, path: { kind: 'root' as const }, cursor: 0, preview: null }
  const treeCtx = { set: vi.fn(), add: vi.fn(), remove: vi.fn() }
  // 按键层复用渲染层 entries（app.tsx 同款接线）——测试里用 buildEntries 现算充当渲染结果。
  const entries = (): ReturnType<typeof buildEntries> => buildEntries(cfg, configView.path, treeCtx)
  const api = { setView, getConfig: () => cfg, treeCtx, entries }

  it('esc 在根层直接关闭编辑器', () => {
    handleConfigKeys(configView, key({ escape: true }), '', api)
    expect(setView).toHaveBeenCalledWith({ kind: 'none' })
  })
  it('↑↓ 在 entries 内循环', () => {
    const es = entries()
    handleConfigKeys(configView, key({ downArrow: true }), '', api)
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 1 % Math.max(1, es.length) }))
    expect(es.length).toBeGreaterThanOrEqual(2) // 根层至少有 permission/providers 两个入口
  })
  it('配置非法时按键不崩（entries 为空）', () => {
    handleConfigKeys(configView, key({ upArrow: true }), '', { setView, getConfig: () => null, treeCtx, entries: () => [] })
    expect(setView).toHaveBeenCalledWith(expect.objectContaining({ cursor: 0 }))
  })
})

describe('handleSuggestionKeys', () => {
  const api = (input: string, cursor: number | null) => ({
    getInput: () => input, getSuggestCursor: () => cursor,
    setInput: vi.fn(), setSuggestCursor: vi.fn(),
  })
  it('无匹配时不消费按键', () => {
    expect(handleSuggestionKeys(key({ upArrow: true }), '', api('hello world', null))).toBe(false)
  })
  it('↑↓ 在匹配项间循环；部分输入 Tab 补全唯一匹配', () => {
    const a = api('/n', null)
    handleSuggestionKeys(key({ downArrow: true }), '', a)
    expect(a.setSuggestCursor).toHaveBeenCalledWith(0)
    const b = api('/ne', 0) // '/ne' 只匹配 '/new'
    handleSuggestionKeys(key({ tab: true }), '', b)
    expect(b.setInput).toHaveBeenCalledWith('/new')
    expect(b.setSuggestCursor).toHaveBeenCalledWith(null)
  })
  it('esc 清除联想选中', () => {
    const a = api('/n', 0)
    handleSuggestionKeys(key({ escape: true }), '', a)
    expect(a.setSuggestCursor).toHaveBeenCalledWith(null)
  })
})

describe('handleHistoryKeys', () => {
  const mk = (items: string[], cursor: number) => ({
    items, cursor, setCursor: vi.fn(), setInput: vi.fn(),
  })
  it('空历史消费按键但不动作', () => {
    const a = mk([], -1)
    expect(handleHistoryKeys(key({ upArrow: true }), a)).toBe(true)
    expect(a.setInput).not.toHaveBeenCalled()
  })
  it('↑ 从末条开始召回；越过最旧停在第 0 条', () => {
    const a = mk(['a', 'b'], -1)
    handleHistoryKeys(key({ upArrow: true }), a)
    expect(a.setInput).toHaveBeenCalledWith('b')
    handleHistoryKeys(key({ upArrow: true }), { ...a, cursor: 0 })
    expect(a.setCursor).toHaveBeenCalledWith(0)
  })
  it('↓ 越过最新清空输入并退出历史浏览', () => {
    const a = mk(['a', 'b'], 1)
    handleHistoryKeys(key({ downArrow: true }), a)
    expect(a.setCursor).toHaveBeenCalledWith(-1)
    expect(a.setInput).toHaveBeenCalledWith('')
  })
})

describe('handleBrowseKeys', () => {
  const blocks = [
    { kind: 'user', text: 'q' },
    { kind: 'tool', text: 't', toolBody: [{ text: 'x', kind: 'plain' }], toolId: 'c1' },
  ] as unknown as Parameters<typeof handleBrowseKeys>[1] extends never ? never : any[]
  const mk = (browseIdx: number | null) => ({
    getBrowseIdx: () => browseIdx,
    setBrowseIdx: vi.fn(),
    getBlocks: () => blocks,
    isExpanded: vi.fn(() => false),
    toggleExpanded: vi.fn(),
    clearScreenRemount: vi.fn(),
  })
  it('Ctrl+↑ 从 null 进入最末块；Ctrl+↓ 从 null 进入第 0 块', () => {
    const a = mk(null)
    handleBrowseKeys(key({ ctrl: true, upArrow: true }), a)
    expect(a.setBrowseIdx).toHaveBeenCalledWith(blocks.length - 1)
    const b = mk(null)
    handleBrowseKeys(key({ ctrl: true, downArrow: true }), b)
    expect(b.setBrowseIdx).toHaveBeenCalledWith(0)
  })
  it('Enter 仅对可展开块切换折叠并清屏重挂载', () => {
    const a = mk(0) // user 块不可展开
    handleBrowseKeys(key({ return: true }), a)
    expect(a.toggleExpanded).not.toHaveBeenCalled()
    expect(a.clearScreenRemount).not.toHaveBeenCalled()
    const b = mk(1) // tool 块有 toolBody，可展开
    handleBrowseKeys(key({ return: true }), b)
    expect(b.toggleExpanded).toHaveBeenCalledWith(1)
    expect(b.clearScreenRemount).toHaveBeenCalled()
  })
  it('Esc 退出浏览模式', () => {
    const a = mk(1)
    handleBrowseKeys(key({ escape: true }), a)
    expect(a.setBrowseIdx).toHaveBeenCalledWith(null)
  })
})

describe('handleInfoKeys', () => {
  const infoView = { kind: 'info' as const, title: 't', lines: ['l1', 'l2', 'l3'] }
  it('esc 关闭；↑↓ 以 10 行步进翻页', () => {
    handleInfoKeys(infoView, key({ escape: true }), { setView, setInfoScroll: vi.fn() })
    expect(setView).toHaveBeenCalledWith({ kind: 'none' })
    const scroll = vi.fn()
    handleInfoKeys(infoView, key({ upArrow: true }), { setView, setInfoScroll: scroll })
    expect(scroll).toHaveBeenCalledWith(expect.any(Function))
    expect(scroll.mock.calls[0]![0](0)).toBe(2)
  })
})

describe('filterSessions', () => {
  const sessions = [
    { id: 'a1', preview: '修复登录 bug', updatedAt: '2026-09-07T10:00:00Z' },
    { id: 'b2', preview: 'add tests', updatedAt: '2026-09-07T11:00:00Z' },
  ]
  it('空 query 原样返回', () => {
    expect(filterSessions(sessions, '')).toBe(sessions)
  })
  it('按 preview 与 id 大小写不敏感过滤', () => {
    expect(filterSessions(sessions, '登录')).toHaveLength(1)
    expect(filterSessions(sessions, 'B2').map((s) => s.id)).toEqual(['b2'])
    expect(filterSessions(sessions, '不存在的词')).toHaveLength(0)
  })
})

describe('handlePathSuggestKeys', () => {
  // matchPathToken 内部读真实目录——用临时目录构造确定候选（目录在前：sub, a.txt）。
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dogegg-keys-'))
    writeFileSync(join(dir, 'a.txt'), 'x')
    mkdirSync(join(dir, 'sub'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const api = (input: string, cursor: number | null, over: Record<string, unknown> = {}) => ({
    getInput: () => input, getSuggestCursor: () => cursor,
    setSuggestCursor: vi.fn(), applyCompletion: vi.fn(),
    cwd: dir, dismissed: false, dismiss: vi.fn(), ...over,
  })

  it('↑↓ 在候选间循环（目录在前；↑ 从未选中跳到末项）', () => {
    const down = api('@', null)
    handlePathSuggestKeys(key({ downArrow: true }), '', down)
    expect(down.setSuggestCursor).toHaveBeenCalledWith(0)
    const up = api('@', null)
    handlePathSuggestKeys(key({ upArrow: true }), '', up)
    expect(up.setSuggestCursor).toHaveBeenCalledWith(1)
  })

  it('Tab 未选中时补第一个候选（目录）', () => {
    const a = api('@', null)
    handlePathSuggestKeys(key({ tab: true }), '', a)
    expect(a.applyCompletion).toHaveBeenCalledWith({ name: 'sub', isDir: true })
    expect(a.setSuggestCursor).toHaveBeenCalledWith(null)
  })

  it('esc 清除选中并关闭弹框', () => {
    const a = api('@', 0)
    expect(handlePathSuggestKeys(key({ escape: true }), '', a)).toBe(true)
    expect(a.setSuggestCursor).toHaveBeenCalledWith(null)
    expect(a.dismiss).toHaveBeenCalled()
  })

  it('dismissed（已关闭）时整体跳过，Esc 落回其他处理', () => {
    const a = api('@', null, { dismissed: true })
    expect(handlePathSuggestKeys(key({ escape: true }), '', a)).toBe(false)
    expect(a.dismiss).not.toHaveBeenCalled()
  })
})
