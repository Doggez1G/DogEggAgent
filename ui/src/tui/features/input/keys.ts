import type { Key } from 'ink'
import { matchCommands } from '../../../shared'
import { matchPathToken } from './path-suggest'

export interface SuggestionKeysApi {
  setInput(value: string): void
  getInput(): string
  getSuggestCursor(): number | null
  setSuggestCursor(value: number | null): void
  /** skills 动态命令（可选注入）——与内置命令同池参与联想。 */
  skillCommands?: () => { cmd: string; desc: string }[]
}

// 斜杠命令联想按键：有匹配时 ↑↓ 选择、Tab/回车补全、esc 关闭。
// 返回 true 表示按键已被联想处理（调用方不再继续分派）。
export function handleSuggestionKeys(key: Key, inputChar: string, api: SuggestionKeysApi): boolean {
  const matches = matchCommands(api.getInput(), api.skillCommands?.() ?? [])
  if (matches.length === 0) return false
  if (key.upArrow) {
    const cur = api.getSuggestCursor()
    api.setSuggestCursor(cur === null ? matches.length - 1 : (cur - 1 + matches.length) % matches.length)
    return true
  }
  if (key.downArrow) {
    const cur = api.getSuggestCursor()
    api.setSuggestCursor(cur === null ? 0 : (cur + 1) % matches.length)
    return true
  }
  if (key.tab || inputChar === '\t') {
    const idx = api.getSuggestCursor() ?? (matches.length === 1 ? 0 : null)
    if (idx !== null) {
      api.setInput(matches[idx]!.cmd)
      api.setSuggestCursor(null)
    }
    return true
  }
  if (key.escape) { api.setSuggestCursor(null); return true }
  return false
}

export interface PathSuggestKeysApi {
  getInput(): string
  getSuggestCursor(): number | null
  setSuggestCursor(value: number | null): void
  /** 用候选条目补全输入（替换末尾的 @片段）。 */
  applyCompletion(entry: { name: string; isDir: boolean }): void
  /** 会话 cwd（候选来源，仅 cwd 内提供补全）。 */
  cwd: string | undefined
  /** 弹框已被 Esc 关闭（输入变化前不再弹出）——按键层整体跳过，Esc 落回其他处理。 */
  dismissed: boolean
  /** Esc 关闭弹框（输入不变则保持关闭，输入一变即恢复弹出）。 */
  dismiss(): void
}

// @path 联想按键：↑↓ 选择、Tab/回车补全选中项（未选中时 Tab 补第一个、回车仍提交）、esc 关闭弹框。
// 返回 true 表示按键已被联想处理（调用方不再继续分派）。
export function handlePathSuggestKeys(key: Key, inputChar: string, api: PathSuggestKeysApi): boolean {
  if (api.dismissed) return false
  const ps = matchPathToken(api.getInput(), api.cwd)
  if (!ps) return false
  if (key.upArrow) {
    const cur = api.getSuggestCursor()
    api.setSuggestCursor(cur === null ? ps.entries.length - 1 : (cur - 1 + ps.entries.length) % ps.entries.length)
    return true
  }
  if (key.downArrow) {
    const cur = api.getSuggestCursor()
    api.setSuggestCursor(cur === null ? 0 : (cur + 1) % ps.entries.length)
    return true
  }
  if (key.tab || inputChar === '\t') {
    const idx = api.getSuggestCursor() ?? 0
    const entry = ps.entries[idx]
    if (entry) api.applyCompletion(entry)
    api.setSuggestCursor(null)
    return true
  }
  if (key.escape) { api.setSuggestCursor(null); api.dismiss(); return true }
  return false
}

export interface HistoryKeysApi {
  setInput(value: string): void
  items: string[]
  cursor: number
  setCursor(cursor: number): void
}

// 输入历史按键：↑ 召回上一条、↓ 回退（到底清空退出历史浏览）。
// 返回 true 表示 up/down 已消费（空历史等 no-op 也算消费，防止落到其它处理）。
export function handleHistoryKeys(key: Key, api: HistoryKeysApi): boolean {
  if (!key.upArrow && !key.downArrow) return false
  const history = api.items
  if (key.upArrow) {
    if (history.length === 0) return true
    const next = api.cursor < 0 ? history.length - 1 : Math.max(0, api.cursor - 1)
    api.setCursor(next)
    api.setInput(history[next] ?? '')
    return true
  }
  if (history.length === 0 || api.cursor < 0) return true
  const next = api.cursor + 1
  if (next >= history.length) {
    // 到底部——清空输入框，退出历史浏览。
    api.setCursor(-1)
    api.setInput('')
  } else {
    api.setCursor(next)
    api.setInput(history[next] ?? '')
  }
  return true
}
