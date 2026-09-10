import type { PermissionDecision } from '@dogegg/bridge'

// 权限弹层的决策项与文案（view 与 keys 共用）。
// alwaysScope 存在（agent 推导出范围模式）时插入第四档「对此范围不再询问」——点它即接受该模式为
// 会话内范围规则；缺失时维持三档（fail-safe）。措辞在本文件组装，契约只携带模式数据。
export interface DecisionItem {
  decision: PermissionDecision
  label: string
}

export function decisionItems(alwaysScopePattern?: string): DecisionItem[] {
  const items: DecisionItem[] = [
    { decision: 'allow_once', label: '允许一次' },
    { decision: 'allow_always', label: '始终允许（本次会话）' },
  ]
  if (alwaysScopePattern) {
    items.push({ decision: 'allow_always_scoped', label: `对此范围不再询问（${alwaysScopePattern}）` })
  }
  items.push({ decision: 'reject', label: '拒绝' })
  return items
}
