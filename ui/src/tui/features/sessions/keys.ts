import type { Key } from 'ink'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'
import { filterSessions } from './filter'

export interface SessionKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
  suppressEnter(): void
}

// 会话选择器按键：搜索过滤 + ↑↓ 导航 + 回车切换 + d 删除（转确认菜单）+ esc 返回。
export function handleSessionPickerKeys(v: Extract<View, { kind: 'sessionPicker' }>, key: Key, inputChar: string, api: SessionKeysApi): void {
  if (key.escape) { api.setView({ kind: 'none' }) }
  else if (key.return) {
    const filtered = filterSessions(v.sessions, v.query)
    const s = filtered[v.cursor]
    if (s) { api.post({ type: 'resume_session', id: s.id }); api.setView({ kind: 'none' }) }
  } else if (key.upArrow) {
    const filtered = filterSessions(v.sessions, v.query)
    const len = Math.max(1, filtered.length)
    api.setView({ ...v, cursor: (v.cursor - 1 + len) % len })
  } else if (key.downArrow) {
    const filtered = filterSessions(v.sessions, v.query)
    const len = Math.max(1, filtered.length)
    api.setView({ ...v, cursor: (v.cursor + 1) % len })
  } else if (inputChar === 'd' && !key.ctrl && v.query === '') {
    // d 键删除当前选中会话（仅在未搜索时生效——避免输入 d 搜索时误触发）。
    // !key.ctrl：Ctrl+D 被 Ink 解析成 'd' + key.ctrl=true，不排除会误触发删除。
    const filtered = filterSessions(v.sessions, v.query)
    const s = filtered[v.cursor]
    if (s) {
      api.suppressEnter()
      api.setView({ kind: 'menu', title: `删除会话 ${s.id}？`, items: [
        // 确认后先回选择器空壳再删除——session_list 响应只刷新已开的选择器（推送不弹层），删除后列表由此重建。
        { label: '确认删除', onSelect: () => { api.setView({ kind: 'sessionPicker', sessions: [], cursor: 0, query: '' }); api.post({ type: 'delete_session', id: s.id }) } },
        { label: '取消', onSelect: () => api.setView({ kind: 'none' }) },
      ], cursor: 0 })
    }
  } else if (key.backspace || inputChar === '\u007f' || inputChar === '\b') {
    // 退格（P2-25）：Ink 7 对命名键把 input 置空串、key.backspace=true——只认 \u007f/\b
    // 字符形态会漏掉退格（过滤查询删不了字）。三种形态并收：命名键 + 旧终端字符形态。
    api.setView({ ...v, query: v.query.slice(0, -1), cursor: 0 })
  } else if (inputChar && !key.ctrl && !key.meta && inputChar >= ' ') {
    // 搜索输入：累积字符更新过滤
    api.setView({ ...v, query: v.query + inputChar, cursor: 0 })
  }
}
