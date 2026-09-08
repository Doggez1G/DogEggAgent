import { classifyPermission, type Config } from '@dogegg/bridge'

// 工具权限标签（display-only）：null 配置视为 ask。
// 三桶判定逻辑归 bridge 的 classifyPermission——契约 schema 的唯一解释者，UI 不再自行实现。
export function getToolPermission(toolName: string, config: Config | null): string {
  if (!config) return 'ask'
  return classifyPermission(config.permission, toolName)
}

// 生效权限的展示值：区分「配置永久 allow」与「会话内 allow_always 提升」。
// classifyPermission 把会话提升并入 'allow' 桶（与后端网关判定同语义），
// 但展示层必须还原来源——提升只在本会话有效，显示成 allow 会让用户误以为进了永久放行。
export function effectivePerm(
  cfg: { allow: string[]; reject: string[]; ask: string[] },
  name: string,
  sessionAllowed: ReadonlySet<string>,
): string {
  const bucket = classifyPermission(cfg, name, sessionAllowed)
  if (bucket === 'allow' && sessionAllowed.has(name) && !cfg.allow.includes(name)) return 'always'
  return bucket
}

// Tool Calls 行的最终展示标签：用户的显式决策优先——它就是本行授权的直接来源
//（ask 工具被询问后必有决策）；无决策的行（配置放行/会话提升自动放行）回落到生效权限快照。
// 兜底 'ask' 仅在无决策且快照缺失时出现（不应发生于已执行的行）。
export function displayPerm(e: { perm: string; decision?: 'allow_once' | 'allow_always' | 'reject' }): string {
  if (e.decision === 'allow_once') return 'once'
  if (e.decision === 'allow_always') return 'always'
  if (e.decision === 'reject') return 'rejected'
  return e.perm
}
