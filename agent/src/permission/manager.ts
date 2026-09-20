import { basename, dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { PermissionDecision, PermissionConfig, ToolIdentity, ToolPermission, ToolArgs } from '@dogegg/bridge'
import { classifyPermission as classify, primarySpecifier } from '@dogegg/bridge'

// 两层权限的运行时层：配置三桶静态分类（含参数化规则，匹配引擎在 bridge）+ 运行时会话内提升。
// 会话提升为「按工具分组的规则表」：整工具（patterns 空）或范围模式（推导见 permission/derive.ts）。
// ⚠️ 会话隔离：提升只对当前会话生效，新建/切换会话时应调 reset() 清空；resume 时按存档 restore。
export class PermissionManager {
  // tool → 模式数组（空数组 = 整工具提升；非空 = 范围模式，path 已是绝对形式、command 为原文通配）。
  private sessionRules = new Map<string, string[]>()
  // 内置读豁免目录（posix 归一）：read_file 落 ask 且目标在其中时自动 allow。
  // 用途：用户级 skills 目录是 agent 管理的资产——系统提示引导模型读 SKILL.md，不应反复弹审批。
  private readonly builtinReadDirs: string[]
  // 配置三桶（onConfigChanged 重建 manager 时整体替换）。
  private cfg: PermissionConfig
  // 工具身份快照提供者（注册表 identities()）——MCP 服务键匹配按身份进行，不解析 LLM 可见名。
  // 提供者而非快照：注册表随 MCP 启停变化，classify 时现取永远新鲜（缺省 = 无身份，仅走名字分支）。
  private readonly identities?: () => ReadonlyMap<string, ToolIdentity>

  constructor(cfg: PermissionConfig, builtinReadDirs: string[] = [], identities?: () => ReadonlyMap<string, ToolIdentity>) {
    this.cfg = cfg
    this.builtinReadDirs = builtinReadDirs.map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''))
    this.identities = identities
  }

  // classify 的本域职责：把「路径类匹配」归一化到统一坐标系（绝对 posix 路径）后再交给 bridge 引擎。
  // cwd 由调用方传入（ToolExecutor 持有 turn.cwd）——set_cwd 切换目录后天然生效。
  // cwd 缺省（UI display-only 调用）时跳过归一化：display 不传 args，参数化规则本就不参与展示判定。
  classify(tool: string, args?: ToolArgs, cwd?: string): 'allow' | 'reject' | 'ask' {
    const normalizedArgs = cwd ? this.normalizeArgs(args, cwd) : args
    const identities = this.identities?.()
    const decision = cwd
      ? classify(this.normalizeRules(cwd), tool, normalizedArgs, this.sessionRules, identities)
      : classify(this.cfg, tool, normalizedArgs, this.sessionRules, identities)
    // 内置读豁免：仅 read_file、仅配置桶落 ask（reject / 会话提升等更早判定不受影响）。
    if (decision === 'ask' && tool === 'read_file' && this.builtinReadDirs.length > 0) {
      const p = typeof normalizedArgs?.path === 'string' ? normalizedArgs.path : undefined
      if (p && this.builtinReadDirs.some((d) => p === d || p.startsWith(d + '/'))) return 'allow'
    }
    return decision
  }

  // 会话提升落库。allow_always = 整工具（patterns 空，覆盖同工具已有窄范围——提宽不提示，
  // /permissions 可见可撤）；allow_always_scoped = 追加范围模式（去重；path 模式在落库时解析为绝对）。
  apply(tool: string, decision: PermissionDecision, scopePattern?: string, cwd?: string): void {
    if (decision === 'allow_always') {
      this.sessionRules.set(tool, [])
      return
    }
    if (decision === 'allow_always_scoped' && scopePattern) {
      const current = this.sessionRules.get(tool)
      if (current && current.length === 0) return // 已是整工具提升，窄范围无意义
      const resolved = primarySpecifier(tool) === 'path' && cwd ? toMatchablePath(scopePattern, cwd) : scopePattern
      this.sessionRules.set(tool, current ? (current.includes(resolved) ? current : [...current, resolved]) : [resolved])
    }
  }

  // 清空运行时会话提升——新建/切换会话时调用，实现权限会话隔离。
  reset(): void {
    this.sessionRules.clear()
  }

  // 撤销会话提升：不带 pattern 撤整工具；带 pattern 撤单条——撤光即整条提升移除
  //（与配置桶「删光模式留整工具」刻意不同：这里的每条模式是独立的授权事件）。
  revoke(tool: string, pattern?: string): void {
    const patterns = this.sessionRules.get(tool)
    if (!patterns) return
    if (pattern === undefined) {
      this.sessionRules.delete(tool)
      return
    }
    const next = patterns.filter((x) => x !== pattern)
    if (next.length === 0) this.sessionRules.delete(tool)
    else this.sessionRules.set(tool, next)
  }

  // 导出当前会话提升快照（按工具分组）——配置编辑时保留授权、/permissions 展示、会话落盘共用。
  snapshotPermissions(): ToolPermission[] {
    return [...this.sessionRules.entries()].map(([tool, patterns]) => ({ tool, patterns: [...patterns] }))
  }

  // resume 恢复：按存档分组形态直接还原（patterns 空 = 整工具）。
  restore(permissions: ToolPermission[]): void {
    for (const { tool, patterns } of permissions) this.sessionRules.set(tool, [...patterns])
  }

  // 参数侧归一化：path 字段 → 真实绝对 posix 路径（realpath），供「按真实位置」的权限匹配
  //（符号链接逃逸在此被识别：真实位置越出规则范围 → 失配 → 落 ask）。
  private normalizeArgs(args: ToolArgs | undefined, cwd: string): ToolArgs | undefined {
    if (!args || typeof args.path !== 'string') return args
    return { ...args, path: realTargetPath(args.path, cwd) }
  }

  // 规则侧归一化：主参数为 path 的工具，其模式按锚点声明归一（见 normalizePattern）；
  // command 主参数（shell）不动——命令不是路径，无「相对 cwd」概念。
  private normalizeRules(cwd: string): PermissionConfig {
    const mapBucket = (bucket: Record<string, string[]>): Record<string, string[]> =>
      Object.fromEntries(Object.entries(bucket).map(([tool, patterns]) => [
        tool,
        primarySpecifier(tool) === 'path' ? patterns.map((p) => normalizePattern(p, cwd)) : patterns,
      ]))
    return {
      allow: mapBucket(this.cfg.allow),
      reject: mapBucket(this.cfg.reject),
      ask: mapBucket(this.cfg.ask),
    }
  }
}

// 模式归一化：【作用域由锚点声明，归一化只做解析、不决定作用域】（schema 加载期已拒绝无锚点的
// 字面量模式，见 contract/config.ts superRefine）。
// - ./ 或 ../ 开头 → resolve(cwd, p)：cwd 作用域（.. 可出 cwd，写明就行）；
// - ~/ 开头 → resolve(homedir(), p)：主目录作用域；
// - 盘符或 / 开头（绝对）→ resolve 折叠 ..、统一分隔符；
// - 其余（* 开头）→ 原样保留：无锚点，glob 对完整绝对路径从文件系统根匹配。
function normalizePattern(p: string, cwd: string): string {
  const unified = p.replace(/\\/g, '/')
  if (unified.startsWith('./') || unified.startsWith('../')) return resolve(cwd, unified).replace(/\\/g, '/')
  if (unified.startsWith('~/')) return resolve(homedir(), unified.slice(2)).replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(unified) || unified.startsWith('/')) return resolve(unified).replace(/\\/g, '/')
  return unified
}

// 参数 → 真实绝对 posix 路径（realpath）。
// 权限按「真实位置」判定：词法解析（resolve）会被符号链接欺骗——cwd 内的链接指向 cwd 外时，
// 词法路径在范围内而实际读取越界（ADR-0010 匹配语义的边界补全，M2.5）。
// - 目标存在 → realpathSync（OS 沿链接解析真实位置，含 Windows junction）；
// - 目标不存在（write_file 新建）→ 真实父目录 + 文件名（新建文件按将落入的真实目录判定）；
// - 父目录也不存在 → 词法解析兜底（极端）。
function realTargetPath(p: string, cwd: string): string {
  const abs = resolve(cwd, p.replace(/\\/g, '/'))
  try {
    return realpathSync(abs).replace(/\\/g, '/')
  } catch {
    try {
      return resolve(realpathSync(dirname(abs)), basename(abs)).replace(/\\/g, '/')
    } catch {
      return abs.replace(/\\/g, '/')
    }
  }
}

function toMatchablePath(p: string, cwd: string): string {
  // 范围提升落库等场景的模式解析（词法，不含 realpath——模式描述授权意图）。
  return resolve(cwd, p.replace(/\\/g, '/')).replace(/\\/g, '/')
}
