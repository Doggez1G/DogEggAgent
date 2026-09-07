import type { PermissionDecision } from '@dogegg/bridge'

// 权限弹层的决策项与文案（view 与 keys 共用）。
export const DECISIONS: PermissionDecision[] = ['allow_once', 'allow_always', 'reject']
export const DECISION_LABELS = ['允许一次', '始终允许（本次会话）', '拒绝']
