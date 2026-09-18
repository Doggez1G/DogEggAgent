import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMd, skeletonSkillMd } from './parser'

// Skills 管理（M4.1）：自有目录体系 + Agent Skills 规范格式的扫描 / CRUD / 调用渲染。
//
// 立法：
// - 只扫两个目录——用户级 ~/.dogegg/skills/、项目级 <cwd>/.dogegg/skills/；
// - skill 名 = 目录名（唯一事实源），目录名必须匹配 NAME_RE（防路径穿越 + 命令名合法性）；
// - 同名冲突：项目级覆盖用户级（调用/命令联想取项目级），list() 两条都返回（面板两组都可见）；
// - description 来自 frontmatter（渐进披露——系统提示与面板只展示它，正文按需读取）；
// - CRUD 全部限定在两个根目录内（name 校验 + join 后仍在根下，双保险）。

export interface SkillInfo {
  name: string
  description: string
  scope: 'project' | 'user'
  path: string
}

// 目录名 / 命令名立法：小写字母数字连字符，字母开头。
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

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
      if (!dir || !existsSync(dir)) continue
      let entries: string[]
      try {
        entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name)).map((e) => e.name)
      } catch {
        continue // 目录不可读（权限等）：该级跳过，不拖垮整体
      }
      for (const name of entries) {
        const path = join(dir, name, 'SKILL.md')
        if (!existsSync(path)) continue
        try {
          const { description } = parseSkillMd(readFileSync(path, 'utf8'))
          out.push({ name, description, scope, path })
        } catch {
          continue // 单个 skill 解析失败不拖垮整体
        }
      }
    }
    this.cache = out
    return out
  }

  // 增：生成骨架 SKILL.md。name 非法 / 目标已存在 → 抛错（门面转 notice）。
  create(scope: 'project' | 'user', name: string, description: string): void {
    if (!SKILL_NAME_RE.test(name)) throw new Error(`skill 名称只能用小写字母、数字、连字符（且字母开头）：${name}`)
    const dir = this.dirFor(scope)
    if (!dir) throw new Error('项目级 skills 目录不可用（当前无工作目录）')
    const skillDir = join(dir, name)
    if (existsSync(skillDir)) throw new Error(`skill 已存在：${name}（${scope}）`)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skeletonSkillMd(name, description), 'utf8')
    this.invalidate()
  }

  // 改：整文件替换 SKILL.md（TUI $EDITOR / WebUI 编辑弹框保存的落点）。
  update(scope: 'project' | 'user', name: string, content: string): void {
    this.assertInside(scope, name)
    const path = join(this.dirFor(scope)!, name, 'SKILL.md')
    if (!existsSync(path)) throw new Error(`skill 不存在：${name}（${scope}）`)
    writeFileSync(path, content, 'utf8')
    this.invalidate()
  }

  // 删：整个 skill 目录（含资源文件）。幂等——不存在时静默成功（与 session delete 同语义）。
  remove(scope: 'project' | 'user', name: string): void {
    this.assertInside(scope, name)
    rmSync(join(this.dirFor(scope)!, name), { recursive: true, force: true })
    this.invalidate()
  }

  // 查：SKILL.md 全文（编辑弹框 / 详情预览的数据源）。
  read(scope: 'project' | 'user', name: string): string {
    this.assertInside(scope, name)
    const path = join(this.dirFor(scope)!, name, 'SKILL.md')
    if (!existsSync(path)) throw new Error(`skill 不存在：${name}（${scope}）`)
    return readFileSync(path, 'utf8')
  }

  // 调用渲染：项目级优先命中 → 正文 $ARGUMENTS 替换（无占位且带参时追加说明段）。
  // 未命中 / 正文为空 → 抛错（门面转 notice）。
  forInvocation(name: string, args: string): string {
    const found = this.list().filter((s) => s.name === name).find((s) => s.scope === 'project') ?? this.list().find((s) => s.name === name)
    if (!found) throw new Error(`未找到 skill：${name}`)
    const { body } = parseSkillMd(readFileSync(found.path, 'utf8'))
    if (!body) throw new Error(`skill ${name} 的 SKILL.md 正文为空`)
    const trimmedArgs = args.trim()
    if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', trimmedArgs)
    return trimmedArgs ? `${body}\n\n用户参数：${trimmedArgs}` : body
  }

  // 系统提示注入段（渐进披露）：无 skill 返回空串（不注入，省上下文）。
  promptSection(): string {
    const skills = this.list()
    if (skills.length === 0) return ''
    const lines = skills.map((s) => `- ${s.name}：${s.description || '（无描述）'}（${s.path}）`).join('\n')
    return [
      '',
      '## 可用 Skills',
      '以下是可用的 skill 指令文件。当用户请求与某个 skill 的描述相关时，先用 read_file 读取其 SKILL.md 获取完整指令再执行。',
      lines,
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
