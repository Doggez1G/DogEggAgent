import type { z } from 'zod'
import { permissionSchema } from './config'

export type PermissionConfig = z.infer<typeof permissionSchema>

// 权限三桶的纯派生判断——permission schema 的唯一解释者（agent 运行时与 UI 显示共用）。
// 与 isConfigured 同类：对契约数据的纯派生，故住契约包。
// reject 优先（最安全），allow 次之，未列出默认 ask（倾向安全）；
// sessionAllowed 是运行时 allow_always 提升的工具集（agent 注入；UI 显示时不传）。
export function classifyPermission(
  cfg: PermissionConfig,
  tool: string,
  sessionAllowed: ReadonlySet<string> = new Set(),
): 'allow' | 'reject' | 'ask' {
  if (cfg.reject.includes(tool)) return 'reject'
  if (cfg.allow.includes(tool) || sessionAllowed.has(tool)) return 'allow'
  return 'ask'
}
