// 权限配置三桶：allow（自动放行）/ reject（永远拒绝）/ ask（每次询问）。
// 这是配置层的静态分类，运行时层（allow_always 提升）在 runtime.ts。
export interface PermissionConfig {
  allow: string[]
  reject: string[]
  ask: string[]
}

// 纯函数三桶分类。reject 优先（最安全），allow 次之，未列出默认 ask（倾向安全）。
// sessionAllowed 是运行时 allow_always 提升的工具集，命中则视同 allow。
export function classify(
  cfg: PermissionConfig,
  sessionAllowed: ReadonlySet<string>,
  tool: string,
): 'allow' | 'reject' | 'ask' {
  if (cfg.reject.includes(tool)) return 'reject'
  if (cfg.allow.includes(tool) || sessionAllowed.has(tool)) return 'allow'
  return 'ask'
}
