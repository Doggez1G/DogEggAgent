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
//
// 关闭出口立法（2026-09-24）：弹层是「插入」而非「替换」——挂了 returnView（打开前用户
// 停在 /config 树、表单等 overlay 上）时，决议/拒绝后恢复该视图，深层游标与已填字段不丢；
// 未挂 returnView（打开前无视图）时关闭到 none，行为与旧版一致。returnView 的挂载方
// 在 use-agent-events 的 permission_request 分支。
export function handlePermissionKeys(v: Extract<View, { kind: 'permission' }>, key: Key, api: PermissionKeysApi): void {
  const items = decisionItems(v.alwaysScope?.pattern)
  const close: View = v.returnView ?? { kind: 'none' }
  if (key.upArrow) api.setView({ ...v, cursor: (v.cursor + items.length - 1) % items.length })
  else if (key.downArrow) api.setView({ ...v, cursor: (v.cursor + 1) % items.length })
  else if (key.return) { api.post({ type: 'permission_decision', id: v.id, decision: items[v.cursor]!.decision }); api.setView(close) }
  else if (key.escape) { api.post({ type: 'permission_decision', id: v.id, decision: 'reject' }); api.setView(close) }
}
