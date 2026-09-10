import type { Key } from 'ink'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'
import { decisionItems } from './decisions'

export interface PermissionKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
}

// 权限弹层按键：↑↓ 选择决策（第四档「对此范围不再询问」仅在 alwaysScope 存在时出现），
// 回车确认，esc 视为拒绝。
export function handlePermissionKeys(v: Extract<View, { kind: 'permission' }>, key: Key, api: PermissionKeysApi): void {
  const items = decisionItems(v.alwaysScope?.pattern)
  if (key.upArrow) api.setView({ ...v, cursor: (v.cursor + items.length - 1) % items.length })
  else if (key.downArrow) api.setView({ ...v, cursor: (v.cursor + 1) % items.length })
  else if (key.return) { api.post({ type: 'permission_decision', id: v.id, decision: items[v.cursor]!.decision }); api.setView({ kind: 'none' }) }
  else if (key.escape) { api.post({ type: 'permission_decision', id: v.id, decision: 'reject' }); api.setView({ kind: 'none' }) }
}
