import type { Key } from 'ink'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'
import { DECISIONS } from './decisions'

export interface PermissionKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
}

// 权限弹层按键：↑↓ 选择决策，回车确认，esc 视为拒绝。
export function handlePermissionKeys(v: Extract<View, { kind: 'permission' }>, key: Key, api: PermissionKeysApi): void {
  if (key.upArrow) api.setView({ ...v, cursor: (v.cursor + DECISIONS.length - 1) % DECISIONS.length })
  else if (key.downArrow) api.setView({ ...v, cursor: (v.cursor + 1) % DECISIONS.length })
  else if (key.return) { api.post({ type: 'permission_decision', id: v.id, decision: DECISIONS[v.cursor]! }); api.setView({ kind: 'none' }) }
  else if (key.escape) { api.post({ type: 'permission_decision', id: v.id, decision: 'reject' }); api.setView({ kind: 'none' }) }
}
