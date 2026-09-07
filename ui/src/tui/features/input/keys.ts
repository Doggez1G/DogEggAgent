import type { Key } from 'ink'
import { matchCommands } from '../../../shared'

export interface SuggestionKeysApi {
  setInput(value: string): void
  getInput(): string
  getSuggestCursor(): number | null
  setSuggestCursor(value: number | null): void
}

// 斜杠命令联想按键：有匹配时 ↑↓ 选择、Tab/回车补全、esc 关闭。
// 返回 true 表示按键已被联想处理（调用方不再继续分派）。
export function handleSuggestionKeys(key: Key, inputChar: string, api: SuggestionKeysApi): boolean {
  const matches = matchCommands(api.getInput())
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
