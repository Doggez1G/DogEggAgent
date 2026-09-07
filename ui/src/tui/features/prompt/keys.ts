import type { Key } from 'ink'
import type { View } from '../../view-state'

export interface PromptKeysApi {
  setView(view: View): void
}

// 标量输入弹层按键：esc 返回 config 编辑器原位（而非无法退出）。
export function handlePromptKeys(v: Extract<View, { kind: 'prompt' }>, key: Key, api: PromptKeysApi): void {
  if (key.escape) api.setView({ kind: 'config', path: v.returnPath ?? { kind: 'root' }, cursor: v.returnCursor ?? 0, preview: null })
}
