import type { z } from 'zod'
import { permissionSchema, primarySpecifier } from './config'
import { matchGlob, matchWildcard } from './glob'

// v2 grouped 形态（schema transform 的产出——legacy 输入已在加载期归一）。
export type PermissionConfig = z.infer<typeof permissionSchema>

// 工具参数（zod 解析后的 JSON 对象）——参数化规则的匹配对象。
export type ToolArgs = Record<string, unknown>

// 权限三桶的纯派生判断——permission schema 的唯一解释者（agent 运行时与 UI 显示共用）。
// 与 isConfigured 同类：对契约数据的纯派生，故住契约包。
//
// 【v2 配置形态】三桶 = 桶 → 工具 → 模式数组（空数组 = 整工具）。模式经主参数表
// （primarySpecifier：shell → command，其余 → path）落到工具实际参数上匹配。
// 本函数直接消费 grouped 形态逐桶求值——M1 的扁平条目中间模型已取消。
//
// 【优先级立法】reject > sessionAllowed > ask 规则 > allow 规则 > 默认 ask。
// - reject 硬拒绝最优先（安全立法）；
// - sessionRules（运行时会话提升：整工具或范围模式）第二——它是用户在本会话内最新的显式意图
//   （「此工具别再问了」），除 reject 外压过一切；否则对 ask 桶工具（write_file/shell 等
//   最常被提升的）提升会失效。/permissions 可撤销，配置层 reject 仍能压住它。
// - ask 规则压过 allow 规则：显式「强制确认」窄规则压过宽放行（「例外强制确认」）。
// ⚠️ 行为兼容：旧实现里 ask 桶条目只是「未入 allow 的回落默认」，本顺序在 ask 桶为空时与
// 旧顺序（reject > allow含session > 默认）判定逐字节一致。
// sessionRules 是运行时会话提升的规则表（agent 注入；UI 显示时也不传 args，范围模式不参与展示判定）。
//
// 【shell 规则立法】参数化 shell 规则（command 模式）是「便利而非安全边界」：
// 通配会命中 `git status && rm -rf /` 这类命令链。命令链拆分器（逐段判定）是独立后续批次；
// 在此之前，危险命令的防线是 ask 桶显式压制 + 默认 ask。
export function classifyPermission(
  cfg: PermissionConfig,
  tool: string,
  args?: ToolArgs,
  sessionRules?: ReadonlyMap<string, string[]>,
): 'allow' | 'reject' | 'ask' {
  const hit = (bucket: 'allow' | 'reject' | 'ask'): boolean =>
    Object.entries(cfg[bucket]).some(([ruleTool, patterns]) => toolEntryMatches(ruleTool, patterns, tool, args))

  if (hit('reject')) return 'reject'
  if (sessionHit(sessionRules, tool, args)) return 'allow'
  if (hit('ask')) return 'ask'
  if (hit('allow')) return 'allow'
  return 'ask'
}

// 会话提升层命中：整工具（patterns 空）直接命中；范围模式按主参数分派匹配（与配置规则同语义——
// path 分段 glob、command 平文本通配）。匹配前 path 模式应为绝对形式（提升落库时已解析）。
function sessionHit(rules: ReadonlyMap<string, string[]> | undefined, tool: string, args?: ToolArgs): boolean {
  const patterns = rules?.get(tool)
  if (!patterns) return false
  if (patterns.length === 0) return true
  if (!args) return false
  const key = primarySpecifier(tool)
  return patterns.some((p) => {
    const v = args[key]
    if (typeof v !== 'string') return false
    return key === 'path' ? matchGlob(p, v) : matchWildcard(p, v)
  })
}

// 桶内单工具条目的命中判定。
// - 工具名：精确或通配（防御手写通配键；v2 编辑器只产精确名）。
// - 空模式数组 = 整工具规则（出现即命中）。
// - 有模式：主参数在 args 中必须是字符串且任一模式命中（OR）。fail-closed：无参数可比、
//   参数值非字符串、模式全不命中 → 不命中（安全默认）。
// 【匹配语义立法——按主参数分派，各用其贴合的匹配函数】
// - path 主参数（read/write/edit/ls/glob/grep）：matchGlob（路径有层级，段边界是安全性质——
//   `*` 单段、`**` 跨段；作用域由锚点 ./ ~/ 绝对 / * 从根 在归一化阶段声明）；
// - command 主参数（shell）与工具名：matchWildcard（命令与工具名是平文本，* = 任意字符即够，
//   `git *` 通配到结尾）。
// 立法要点：作用域概念只存在于路径；command 模式没有 cwd 概念，「便利而非安全边界」。
function toolEntryMatches(ruleTool: string, patterns: string[], tool: string, args?: ToolArgs): boolean {
  if (ruleTool !== tool && !matchWildcard(ruleTool, tool)) return false
  if (patterns.length === 0) return true
  if (!args) return false
  const key = primarySpecifier(ruleTool)
  const matches = (p: string, v: string): boolean => (key === 'path' ? matchGlob(p, v) : matchWildcard(p, v))
  return patterns.some((p) => {
    const v = args[key]
    return typeof v === 'string' && matches(p, v)
  })
}
