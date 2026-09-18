import type { Key } from 'ink'
import type { View } from '../../view-state'

export interface PromptKeysApi {
  setView(view: View): void
}

// 标量输入弹层按键：esc 返回来源（显式 returnView 优先——如 skills 面板创建流；缺省回 config 编辑器原位）。
export function handlePromptKeys(v: Extract<View, { kind: 'prompt' }>, key: Key, api: PromptKeysApi): void {
  if (key.escape) {
    if (v.returnView) { api.setView(v.returnView); return }
    api.setView({ kind: 'config', path: v.returnPath ?? { kind: 'root' }, cursor: v.returnCursor ?? 0, preview: null })
  }
}
