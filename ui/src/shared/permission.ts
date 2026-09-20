import { classifyPermission, type Config, type PermissionConfig, type PermissionRule } from '@dogegg/bridge'

// 工具权限标签（display-only）：null 配置视为 ask。
// 三桶判定逻辑归 bridge 的 classifyPermission——契约 schema 的唯一解释者，UI 不再自行实现。
// display 不传 args：参数化模式（如「允许读 docs/**」）在无参数可比时按 fail-closed 不命中，
// 标签回落到整键规则/默认 ask——展示层宁可保守，不替参数化规则宣称放行。
export function getToolPermission(toolName: string, config: Config | null): string {
  if (!config) return 'ask'
  return classifyPermission(config.permission, toolName)
}

// 桶内内建工具键的摘要文案（TUI 配置树用；WebUI 设置面板为全英文文案，就地内联同义表述）。
// v3 三态：整选（whole，含保留模式）/ 按模式 / 空选（whole:false + 无模式 = 不命中任何规则）。
export function describeBucketTool(rule: PermissionRule): string {
  if (rule.whole) return rule.patterns.length > 0 ? `整工具（保留 ${rule.patterns.length} 条模式）` : '整工具'
  return rule.patterns.length === 0 ? '未选择（不命中）' : `${rule.patterns.length} 条模式`
}

// 生效权限的展示值：区分「配置永久 allow」与「会话内提升」（整工具或范围模式）。
// classifyPermission 把会话提升并入 'allow' 桶（与后端网关判定同语义），
// 但展示层必须还原来源——提升只在本会话有效，显示成 allow 会让用户误以为进了永久放行。
export function effectivePerm(
  cfg: PermissionConfig,
  name: string,
  sessionRules: ReadonlyMap<string, string[]>,
): string {
  const bucket = classifyPermission(cfg, name, undefined, sessionRules)
  if (bucket === 'allow' && sessionRules.has(name) && !(name in cfg.allow)) return 'always'
  return bucket
}

// Tool Calls 行的最终展示标签：用户的显式决策优先——它就是本行授权的直接来源
//（ask 工具被询问后必有决策）；无决策的行（配置放行/会话提升自动放行）回落到生效权限快照。
// 兜底 'ask' 仅在无决策且快照缺失时出现（不应发生于已执行的行）。
export function displayPerm(e: {
  perm: string
  decision?: 'allow_once' | 'allow_always' | 'allow_always_scoped' | 'reject'
}): string {
  if (e.decision === 'allow_once') return 'once'
  if (e.decision === 'allow_always') return 'always'
  if (e.decision === 'allow_always_scoped') return 'scoped'
  if (e.decision === 'reject') return 'rejected'
  return e.perm
}
