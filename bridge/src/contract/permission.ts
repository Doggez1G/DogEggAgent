import type { z } from 'zod'
import { permissionSchema, primarySpecifier, type PermissionRule } from './config'
import { matchGlob, matchWildcard } from './glob'
import type { ToolIdentity } from './tools'

// v3 结构化形态（schema 的产出——唯一合法格式，旧格式不受兼容，见 ADR-0013）。
export type PermissionConfig = z.infer<typeof permissionSchema>

// 工具参数（zod 解析后的 JSON 对象）——参数化规则的匹配对象。
export type ToolArgs = Record<string, unknown>

// 权限三桶的纯派生判断——permission schema 的唯一解释者（agent 运行时与 UI 显示共用）。
// 与 isConfigured 同类：对契约数据的纯派生，故住契约包。
//
// 【v3 配置形态】三桶 = 键 → { whole, patterns }。whole: true → 整键命中（整工具/整组），
// patterns 保留但不参与匹配；whole: false → patterns 生效（OR），空数组 = 键存在但不命中
// 任何规则（编辑中空选）。模式经主参数表（primarySpecifier：shell → command，其余 → path）
// 落到工具实际参数上匹配；MCP 服务键的 patterns 是内部工具名选择器（见服务键立法）。
// 本函数直接消费结构化形态逐桶求值。
//
// 【优先级立法】reject > sessionAllowed > ask 规则 > allow 规则 > 默认 ask。
// - reject 硬拒绝最优先（安全立法）；
// - sessionRules（运行时会话提升：整工具或范围模式）第二——它是用户在本会话内最新的显式意图
//   （「此工具别再问了」），除 reject 外压过一切；否则对 ask 桶工具（write_file/shell 等
//   最常被提升的）提升会失效。/permissions 可撤销，配置层 reject 仍能压住它。
// - ask 规则压过 allow 规则：显式「强制确认」窄规则压过宽放行（「例外强制确认」）。
// sessionRules 是运行时会话提升的规则表（agent 注入；UI 显示时也不传 args，范围模式不参与展示判定）。
// 会话提升保留「空数组 = 整工具提升」的内部语义——它是运行时内存结构而非用户配置，
// 不受配置 v3「空选 = 不命中」立法影响。
//
// 【shell 规则立法】参数化 shell 规则（command 模式）是「便利而非安全边界」：
// 通配会命中 `git status && rm -rf /` 这类命令链。命令链拆分器（逐段判定）是独立后续批次；
// 在此之前，危险命令的防线是 ask 桶显式压制 + 默认 ask。
// 【MCP 服务键立法】桶键除内建工具名外，还可以是 **`mcp:<服务裸名>`**（如 `mcp:playwright`）——
// 前缀使服务键与内建工具键的键空间彻底正交（内建名不含冒号），「这个键是不是服务键」由语法
// 自明，无需身份快照或启发式判定。语义：kind='mcp' 的工具按注册期身份（server + 内部工具名）
// 匹配其前缀键。rule.whole = 整组生效（该服务下所有工具，不管内部名字如何）；whole: false 时
// patterns 与内部工具名做平文本精确/通配（matchWildcard）——【工具启用匹配，永不涉及执行参数】。
// 名字分支（toolEntryMatches）对所有工具照常生效——手写的 `mcp__x__*` 通配键、内建键走它；
// 两分支任一命中即桶命中。跨桶优先级不受影响：「allow 整组 + ask 勾选个别」可行，反向（ask
// 整组 + allow 个别）被桶优先级压制。
export function classifyPermission(
  cfg: PermissionConfig,
  tool: string,
  args?: ToolArgs,
  sessionRules?: ReadonlyMap<string, string[]>,
  identities?: ReadonlyMap<string, ToolIdentity>,
): 'allow' | 'reject' | 'ask' {
  const hit = (bucket: 'allow' | 'reject' | 'ask'): boolean =>
    Object.entries(cfg[bucket]).some(([ruleTool, rule]) => toolEntryMatches(ruleTool, rule, tool, args)) ||
    mcpServerHit(cfg[bucket], tool, identities)

  if (hit('reject')) return 'reject'
  if (sessionHit(sessionRules, tool, args)) return 'allow'
  if (hit('ask')) return 'ask'
  if (hit('allow')) return 'allow'
  return 'ask'
}

// 服务键分支命中：工具身份为 mcp 时，在其 `mcp:<服务名>` 前缀桶键上按规则语义判定。
// 身份由注册关口随工具维护（agent 注入快照）——匹配不解析 LLM 可见名，服务名含任何字符都无歧义。
function mcpServerHit(
  bucket: Record<string, PermissionRule>,
  tool: string,
  identities?: ReadonlyMap<string, ToolIdentity>,
): boolean {
  const id = identities?.get(tool)
  if (id?.kind !== 'mcp') return false
  const rule = bucket[`mcp:${id.server}`]
  if (!rule) return false
  if (rule.whole) return true
  return rule.patterns.some((p) => matchWildcard(p, id.name))
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

// 桶内单键规则的命中判定。
// - 工具名：精确或通配（防御手写通配键；编辑器只产精确名）。
// - rule.whole = 整键规则（出现即命中，patterns 不参与）。
// - whole: false → patterns 匹配：主参数在 args 中必须是字符串且任一模式命中（OR）。
//   空数组 = 键存在但不命中任何规则（编辑中空选）。fail-closed：无参数可比、参数值非字符串、
//   模式全不命中 → 不命中（安全默认）。
// 【匹配语义立法——按主参数分派，各用其贴合的匹配函数】
// - path 主参数（read/write/edit/ls/glob/grep）：matchGlob（路径有层级，段边界是安全性质——
//   `*` 单段、`**` 跨段；作用域由锚点 ./ ~/ 绝对 / * 从根 在归一化阶段声明）；
// - command 主参数（shell）与工具名：matchWildcard（命令与工具名是平文本，* = 任意字符即够，
//   `git *` 通配到结尾）。
// 立法要点：作用域概念只存在于路径；command 模式没有 cwd 概念，「便利而非安全边界」。
function toolEntryMatches(ruleTool: string, rule: PermissionRule, tool: string, args?: ToolArgs): boolean {
  if (ruleTool !== tool && !matchWildcard(ruleTool, tool)) return false
  if (rule.whole) return true
  if (!args) return false
  const key = primarySpecifier(ruleTool)
  const matches = (p: string, v: string): boolean => (key === 'path' ? matchGlob(p, v) : matchWildcard(p, v))
  return rule.patterns.some((p) => {
    const v = args[key]
    return typeof v === 'string' && matches(p, v)
  })
}
