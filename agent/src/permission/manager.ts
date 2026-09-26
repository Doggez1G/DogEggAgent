import { basename, dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { PermissionDecision, PermissionConfig, ToolIdentity, ToolPermission, ToolArgs } from '@dogegg/bridge'
import { classifyPermission as classify, primarySpecifier } from '@dogegg/bridge'

// 两层权限的运行时层：配置三桶静态分类（含参数化规则，匹配引擎在 bridge）+ 运行时会话内提升。
// 会话提升为「按工具分组的规则表」：整工具（patterns 空）或范围模式（推导见 permission/derive.ts）。
// ⚠️ 会话隔离：提升只对当前会话生效，新建/切换会话时应调 reset() 清空；resume 时按存档 restore。
export class PermissionManager {
  // tool → 模式数组（空数组 = 整工具提升；非空 = 范围模式，path 已是绝对形式且经 fold 归一
  //（见 foldPath / toMatchablePath），command 为原文通配——command 有大小写语义，绝不 fold）。
  private sessionRules = new Map<string, string[]>()
  // 内置读豁免目录（posix 归一 + fold）：read_file 落 ask 且目标在其中时自动 allow。
  // 用途：用户级 skills 目录是 agent 管理的资产——系统提示引导模型读 SKILL.md，不应反复弹审批。
  // fold 与参数侧对齐：normalizeArgs 产出的 path 在 win32 上是小写形式，豁免表不同步 fold
  // 就会因大小写恒失配、豁免静默失效（见 foldPath 立法）。
  private readonly builtinReadDirs: string[]
  // 配置三桶（onConfigChanged 重建 manager 时整体替换）。
  private cfg: PermissionConfig
  // 工具身份快照提供者（注册表 identities()）——MCP 服务键匹配按身份进行，不解析 LLM 可见名。
  // 提供者而非快照：注册表随 MCP 启停变化，classify 时现取永远新鲜（缺省 = 无身份，仅走名字分支）。
  private readonly identities?: () => ReadonlyMap<string, ToolIdentity>

  constructor(cfg: PermissionConfig, builtinReadDirs: string[] = [], identities?: () => ReadonlyMap<string, ToolIdentity>) {
    this.cfg = cfg
    this.builtinReadDirs = builtinReadDirs.map((d) => foldPath(d.replace(/\\/g, '/').replace(/\/+$/, '')))
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
      // ^ 范围提升的 path 侧在落库时归一为「可匹配形态」（绝对 + posix + fold）——bridge 引擎的
      //   匹配恒大小写敏感，fold 只能在此（写入口）做，读取侧（classify → bridge）无需感知。
      //   撤销（revoke）比对的是 snapshotPermissions 导出的同形态字符串，往返一致。
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

  // 规则侧归一化：主参数为 path 的内建工具，其 patterns 按锚点声明归一（见 normalizePattern）；
  // shell（command 主参数）与 MCP 服务键一律不动——均无「相对 cwd」概念。
  // 服务键识别：`mcp:` 前缀（规范式立法——前缀即语义，无需身份快照判定）。
  private normalizeRules(cwd: string): PermissionConfig {
    const isServiceKey = (key: string): boolean => key.startsWith('mcp:')
    const mapBucket = (bucket: PermissionConfig['allow']): PermissionConfig['allow'] =>
      Object.fromEntries(Object.entries(bucket).map(([tool, rule]) => [
        tool,
        primarySpecifier(tool) === 'path' && !isServiceKey(tool)
          ? { ...rule, patterns: rule.patterns.map((p) => normalizePattern(p, cwd)) }
          : rule,
      ]))
    return {
      allow: mapBucket(this.cfg.allow),
      reject: mapBucket(this.cfg.reject),
      ask: mapBucket(this.cfg.ask),
    }
  }
}

// 大小写归一（P2-12 立法，win32 only）：Windows 文件系统（NTFS 默认）大小写不敏感——
// `D:/Proj/a.ts` 与 `d:/proj/A.TS` 是同一文件；而 bridge 的 matchGlob 与本文件的 normalizePattern
// 恒按大小写敏感匹配。后果：小写盘符模式 `d:/proj/**` 与 realpath 归一后的参数（携带磁盘上的
// 真实大小写）恒失配 → 权限判定静默回落 ask，用户配置「写了却像没写」。因此 win32 上把
// path 类字符串统一 toLowerCase（fold）后再匹配：模式侧（normalizePattern / toMatchablePath）、
// 参数侧（realTargetPath）与内置豁免表（builtinReadDirs）两侧同步 fold，匹配在 fold 后的
// 同一坐标系进行。边界（刻意收窄 fold 的范围）：
// - 仅 path 类——shell 的 command 大小写有语义（`/i` 与 `/I`、`-D` 与 `-d` 在部分工具里含义
//   不同，命令匹配必须保持敏感），工具名恒小写不涉及。fold 只出现在 path 专用函数内，
//   command 链路物理上碰不到它；
// - 仅 win32——posix 文件系统大小写敏感，fold 会在 Linux/macOS 上把两个真实不同的文件
//   混为一谈（`File.ts` ≠ `file.ts`），绝不能开。
// 本函数必须与使用点成对出现：任何新的 path 类匹配点，两侧都要过 fold，否则单侧 fold 会让
// 失配方向反转（配上了却匹配不上，或反之）。
function foldPath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

// 模式归一化：【作用域由锚点声明，归一化只做解析、不决定作用域】（schema 加载期已拒绝无锚点的
// 字面量模式，见 contract/config.ts superRefine）。
// - ./ 或 ../ 开头 → resolve(cwd, p)：cwd 作用域（.. 可出 cwd，写明就行）；
// - ~/ 开头 → resolve(homedir(), p)：主目录作用域；
// - 盘符或 / 开头（绝对）→ resolve 折叠 ..、统一分隔符；
// - 其余（* 开头）→ 原样保留：无锚点，glob 对完整绝对路径从文件系统根匹配。
// 各分支产出统一过 foldPath（P2-12）：本函数只服务 path 类工具（调用方已按 primarySpecifier
// 过滤），模式与参数在 win32 上同归一小写坐标系后才可比——盘符分支尤其典型：用户写
// `d:/proj/**`（小写盘符），而 realpath/resolve 产出的是磁盘真实大小写，不 fold 恒失配。
function normalizePattern(p: string, cwd: string): string {
  const unified = p.replace(/\\/g, '/')
  if (unified.startsWith('./') || unified.startsWith('../')) return foldPath(resolve(cwd, unified).replace(/\\/g, '/'))
  if (unified.startsWith('~/')) return foldPath(resolve(homedir(), unified.slice(2)).replace(/\\/g, '/'))
  if (/^[a-zA-Z]:\//.test(unified) || unified.startsWith('/')) return foldPath(resolve(unified).replace(/\\/g, '/'))
  return foldPath(unified)
}

// 参数 → 真实绝对 posix 路径（realpath），产出过 foldPath（P2-12，见上方立法）。
// 权限按「真实位置」判定：词法解析（resolve）会被符号链接欺骗——cwd 内的链接指向 cwd 外时，
// 词法路径在范围内而实际读取越界（ADR-0010 匹配语义的边界补全，M2.5）。
// - 目标存在 → realpathSync（OS 沿链接解析真实位置，含 Windows junction）；
// - 目标不存在（write_file 新建）→ 真实父目录 + 文件名（新建文件按将落入的真实目录判定）；
// - 父目录也不存在 → 词法解析兜底（极端）。
//
// TOCTOU 立法：classify（本函数 realpath 判权）与工具实际 open 是两次独立的 IO——符号链接
// 在两步之间被换向存在理论窗口（判权时指向范围内、打开时已被换成范围外目标）。本地单用户
// 威胁模型下接受该窗口（攻击者与被保护对象同权，无需绕权限）；根治需执行侧在 open 前对
// 同一目标再做一次 realpath 校验（INV-3 权限边界，属工具执行层职责，不在本匹配层）。
function realTargetPath(p: string, cwd: string): string {
  const abs = resolve(cwd, p.replace(/\\/g, '/'))
  try {
    return foldPath(realpathSync(abs).replace(/\\/g, '/'))
  } catch {
    try {
      return foldPath(resolve(realpathSync(dirname(abs)), basename(abs)).replace(/\\/g, '/'))
    } catch {
      return foldPath(abs.replace(/\\/g, '/'))
    }
  }
}

function toMatchablePath(p: string, cwd: string): string {
  // 范围提升落库等场景的模式解析（词法，不含 realpath——模式描述授权意图）。
  // 过 foldPath 与参数侧（realTargetPath）同坐标系：会话提升的模式同样要能在 win32 上
  // 命中真实大小写的路径（P2-12）。
  return foldPath(resolve(cwd, p.replace(/\\/g, '/')).replace(/\\/g, '/'))
}
