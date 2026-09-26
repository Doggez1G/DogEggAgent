import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSkillMd, skeletonSkillMd } from './parser'
import { atomicWriteFileSync } from '../shared'

// Skills 管理（M4.1）：自有目录体系 + Agent Skills 规范格式的扫描 / CRUD / 调用渲染。
//
// 立法：
// - 只扫两个目录——用户级 ~/.dogegg/skills/、项目级 <cwd>/.dogegg/skills/；
// - skill 名 = 目录名（唯一事实源），目录名必须匹配 NAME_RE（防路径穿越 + 命令名合法性）；
// - 同名冲突：项目级覆盖用户级（调用/命令联想取项目级），list() 两条都返回（面板两组都可见）；
// - description 来自 frontmatter（渐进披露——系统提示与面板只展示它，正文按需读取）；
// - CRUD 全部限定在两个根目录内（name 校验 + join 后仍在根下，双保险）；
// - 启停状态（M4.3）：旁挂状态文件与目录同层（用户级 ~/.dogegg/.skills.json、项目级
//   <repo>/.dogegg/.skills.json，与 .mcp.json 同构）——只记停用名单（缺省即启用），
//   不碰主流 SKILL.md 格式；项目级停用随 .dogegg/ 进 git 与仓库共享。
// - 条目三态：启用（在目录且未停用）/ 停用（在目录且在名单）/ 文件缺失（在名单但目录已消失
//   ——外部删除产生，可见供清理，永不进系统提示与调用）。

export interface SkillInfo {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
  /** false = 停用名单在案（系统提示/联想/调用全部不可见）。 */
  enabled: boolean
  /** true = 状态名单在案但文件系统已消失（孤儿）——仅供展示与清理。 */
  missing: boolean
}

// 目录名 / 命令名立法：小写字母数字连字符，字母开头。
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// 系统提示段条数上限（见 promptSection 立法注释）：超过只列前 N 条 + 溢出提示行。
export const PROMPT_SECTION_LIMIT = 60

export class SkillsManager {
  private projectDir: string | undefined
  // 清单缓存：系统提示段与 token 估算在每次状态变化时都会触发 list()——
  // 现扫文件系统会成为热路径。缓存在任何写操作 / setProjectDir / invalidate() 时失效；
  // skills_request（面板/联想刷新）走门面的 invalidate + list，保证外部手改文件可见。
  private cache: SkillInfo[] | null = null

  constructor(private readonly userDir: string) {}

  // 项目级目录随会话 cwd 走——/cd 后由门面调用并重扫广播。
  setProjectDir(cwd: string): void {
    this.projectDir = join(cwd, '.dogegg', 'skills')
    this.invalidate()
  }

  // 失效缓存（门面在 skills_request / 管理操作后调用，保证外部手改可见）。
  invalidate(): void {
    this.cache = null
  }

  userDirPath(): string {
    return this.userDir
  }

  private dirFor(scope: 'project' | 'user'): string | undefined {
    return scope === 'user' ? this.userDir : this.projectDir
  }

  // 扫描两级目录 → SkillInfo 列表（项目在前、各自字母序）。目录不存在 / SKILL.md 缺失的项跳过。
  // 带缓存：热路径（系统提示段/估算）复用，写操作与显式 invalidate 失效。
  list(): SkillInfo[] {
    if (this.cache) return this.cache
    const out: SkillInfo[] = []
    for (const scope of ['project', 'user'] as const) {
      const dir = this.dirFor(scope)
      if (!dir) continue
      const disabled = new Set(this.readDisabled(scope))
      const found = new Set<string>()
      // 目录存在才扫文件；目录整体消失但状态名单还在时，孤儿枚举照常（见下）——可见供清理。
      if (existsSync(dir)) {
        let entries: string[]
        try {
          entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name)).map((e) => e.name)
        } catch {
          entries = [] // 目录不可读（权限等）：按无条目处理，孤儿枚举照常
        }
        for (const name of entries) {
          const path = join(dir, name, 'SKILL.md')
          if (!existsSync(path)) continue
          try {
            const { description } = parseSkillMd(readFileSync(path, 'utf8'))
            found.add(name)
            out.push({ name, description, scope, path, enabled: !disabled.has(name), missing: false })
          } catch {
            // SKILL.md 解析失败：条目照常可见（不隐身），标明原因供诊断——它仍参与停用名单语义。
            found.add(name)
            out.push({ name, description: '（SKILL.md 解析失败——请检查 frontmatter/正文）', scope, path, enabled: !disabled.has(name), missing: false })
          }
        }
      }
      // 名单孤儿：停用名单在案、文件系统已消失（外部删除等）——可见供清理，永不进提示/调用。
      for (const name of disabled) {
        if (found.has(name) || !SKILL_NAME_RE.test(name)) continue
        out.push({ name, description: '（目录已不存在）', scope, path: join(dir, name, 'SKILL.md'), enabled: false, missing: true })
      }
    }
    this.cache = out
    return out
  }

  // ── 启停状态（M4.3）：旁挂名单文件 ──

  // 状态文件与 skills 目录同层（dirname）——用户级 ~/.dogegg/.skills.json、项目级 <repo>/.dogegg/.skills.json。
  private statePathFor(scope: 'project' | 'user'): string {
    const dir = this.dirFor(scope)
    if (!dir) throw new Error('项目级 skills 目录不可用（当前无工作目录）')
    return join(dirname(dir), '.skills.json')
  }

  // 读停用名单：文件缺失/损坏/形状不符一律视为空名单（不拖垮 skills 功能——外部手改损坏可删文件自愈）。
  private readDisabled(scope: 'project' | 'user'): string[] {
    const file = this.statePathFor(scope)
    if (!existsSync(file)) return []
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { disabled?: unknown }
      if (!Array.isArray(raw.disabled)) return []
      return raw.disabled.filter((x): x is string => typeof x === 'string')
    } catch {
      return []
    }
  }

  private writeDisabled(scope: 'project' | 'user', names: string[]): void {
    const file = this.statePathFor(scope)
    mkdirSync(dirname(file), { recursive: true })
    // 原子写（立法见 shared/atomic.ts）：.skills.json 是启停状态的唯一副本，直接写中断会留
    // 半截 JSON——readDisabled 对损坏文件按空名单自愈，但用户的停用清单会静默丢失。
    atomicWriteFileSync(file, JSON.stringify({ disabled: names }, null, 2))
  }

  // 启停：更新旁挂名单并失效缓存。启用一个 missing 条目 = 清理孤儿记录。
  setEnabled(scope: 'project' | 'user', name: string, enabled: boolean): void {
    this.assertInside(scope, name)
    const names = this.readDisabled(scope)
    const next = enabled ? names.filter((n) => n !== name) : (names.includes(name) ? names : [...names, name])
    this.writeDisabled(scope, next)
    this.invalidate()
  }

  // 增：生成骨架 SKILL.md。name 非法 / 目标已存在 → 抛错（门面转 notice）。
  // 同名重建（此前停用后被删）视为全新开始——从停用名单移除，新 skill 默认启用。
  create(scope: 'project' | 'user', name: string, description: string): void {
    if (!SKILL_NAME_RE.test(name)) throw new Error(`skill 名称只能用小写字母、数字、连字符（且字母开头）：${name}`)
    const dir = this.dirFor(scope)
    if (!dir) throw new Error('项目级 skills 目录不可用（当前无工作目录）')
    const skillDir = join(dir, name)
    if (existsSync(skillDir)) throw new Error(`skill 已存在：${name}（${scope}）`)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skeletonSkillMd(name, description), 'utf8')
    this.writeDisabled(scope, this.readDisabled(scope).filter((n) => n !== name))
    this.invalidate()
  }

  // 改：整文件替换 SKILL.md（TUI $EDITOR / WebUI 编辑弹框保存的落点）。
  // content 为空串直接拒绝（防清空立法）：编辑弹框把全文清空后保存，会把 SKILL.md 写成空文件，
  // skill 从此不可调用且 description 丢失——用户十有八九是误操作；如真要清空应直接删除该 skill。
  update(scope: 'project' | 'user', name: string, content: string): void {
    if (!content) throw new Error('SKILL.md 内容不能为空——如需清空请直接删除该 skill')
    this.assertInside(scope, name)
    const path = join(this.dirFor(scope)!, name, 'SKILL.md')
    if (!existsSync(path)) throw new Error(`skill 不存在：${name}（${scope}）`)
    writeFileSync(path, content, 'utf8')
    this.invalidate()
  }

  // 删：整个 skill 目录（含资源文件）。幂等——不存在时静默成功（与 session delete 同语义，
  // 也是缺失态条目「删除即清理」的落点）；名单同步清理，不留孤儿记录（外部删除才产生孤儿）。
  remove(scope: 'project' | 'user', name: string): void {
    this.assertInside(scope, name)
    rmSync(join(this.dirFor(scope)!, name), { recursive: true, force: true })
    this.writeDisabled(scope, this.readDisabled(scope).filter((n) => n !== name))
    this.invalidate()
  }

  // 查：SKILL.md 全文（编辑弹框 / 详情预览的数据源）。
  read(scope: 'project' | 'user', name: string): string {
    this.assertInside(scope, name)
    const path = join(this.dirFor(scope)!, name, 'SKILL.md')
    if (!existsSync(path)) throw new Error(`skill 不存在：${name}（${scope}）`)
    return readFileSync(path, 'utf8')
  }

  // 调用渲染：可用（enabled 且非缺失）条目内项目级优先命中 → 正文 $ARGUMENTS 替换（无占位且带参时追加说明段）。
  // 停用/缺失 = 退出竞争（项目级停用时同名用户级照常生效）；全部未命中 → 抛错（门面转 notice）。
  forInvocation(name: string, args: string): string {
    const available = this.list().filter((s) => s.enabled && !s.missing)
    const found = available.filter((s) => s.name === name).find((s) => s.scope === 'project') ?? available.find((s) => s.name === name)
    if (!found) throw new Error(`未找到 skill：${name}（可能已停用或目录缺失）`)
    const { body } = parseSkillMd(readFileSync(found.path, 'utf8'))
    if (!body) throw new Error(`skill ${name} 的 SKILL.md 正文为空`)
    const trimmedArgs = args.trim()
    if (body.includes('$ARGUMENTS')) {
      // 函数式替换（replaceAll 的 replacer 形态）：参数文本里的 $$ / $& / $' 等特殊序列
      // 在字符串形态的替换值里会被重新解释改写（如 $$ → $），注入的用户参数被篡改——
      // 函数式返回值按字面插入，不做二次解释。
      return body.replaceAll('$ARGUMENTS', () => trimmedArgs)
    }
    return trimmedArgs ? `${body}\n\n用户参数：${trimmedArgs}` : body
  }

  // 系统提示注入段（渐进披露）：只列可用条目（停用/缺失不广告）；无 skill 返回空串（不注入，省上下文）。
  // 条数上限（PROMPT_SECTION_LIMIT）：技能段直接计入 system prompt 占用——大量技能时无上限注入
  // 会挤占上下文窗口，且该段是固定开销，自动压缩永远追不平（压缩掉对话省不回清单段）。
  // 超限只列前 60 条并指路 /skills 完整清单（面板/命令联想仍可见全部）。
  promptSection(): string {
    const skills = this.list().filter((s) => s.enabled && !s.missing)
    if (skills.length === 0) return ''
    const shown = skills.slice(0, PROMPT_SECTION_LIMIT)
    const rest = skills.length - shown.length
    const lines = shown.map((s) => `- ${s.name}：${s.description || '（无描述）'}（${s.path}）`).join('\n')
    return [
      '',
      '## 可用 Skills',
      '以下是可用的 skill 指令文件。当用户请求与某个 skill 的描述相关时，先用 read_file 读取其 SKILL.md 获取完整指令再执行。',
      lines,
      ...(rest > 0 ? [`…另有 ${rest} 个 skill 未列出（完整清单见 /skills）`] : []),
    ].join('\n')
  }

  // 路径安全双保险：name 已过 NAME_RE，这里再确认 join 结果不越出根目录。
  private assertInside(scope: 'project' | 'user', name: string): void {
    if (!SKILL_NAME_RE.test(name)) throw new Error(`非法 skill 名称：${name}`)
    const dir = this.dirFor(scope)
    if (!dir) throw new Error('项目级 skills 目录不可用（当前无工作目录）')
    const resolved = join(dir, name)
    if (!resolved.startsWith(dir)) throw new Error(`skill 路径越界：${name}`)
  }
}
