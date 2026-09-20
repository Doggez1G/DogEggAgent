import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { SkillsManager, SKILL_NAME_RE } from '../../src/skills'

// Skills 管理单测：扫描（项目覆盖用户）/ CRUD（目录名立法 + 路径安全）/ 调用渲染 / 系统提示段。
let root: string | null = null
afterEach(() => {
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
})

function make(): { root: string; user: string; project: string; mgr: SkillsManager } {
  root = mkdtempSync(join(tmpdir(), 'dogegg-skills-'))
  const user = join(root, 'user-skills')
  const project = join(root, 'proj', '.dogegg', 'skills')
  const mgr = new SkillsManager(user)
  mgr.setProjectDir(join(root, 'proj'))
  return { root: root!, user, project, mgr }
}

describe('SkillsManager', () => {
  it('扫描两级目录：项目级与用户级都返回；description 取 frontmatter', () => {
    const { user, project, mgr } = make()
    mkdirSync(join(user, 'alpha'), { recursive: true })
    writeFileSync(join(user, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 用户级的 alpha\n---\n正文A')
    mkdirSync(join(project, 'beta'), { recursive: true })
    writeFileSync(join(project, 'beta', 'SKILL.md'), '---\ndescription: 项目级的 beta\n---\n正文B')
    const list = mgr.list()
    expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual(['project:beta', 'user:alpha'])
    expect(list[0]!.description).toBe('项目级的 beta')
    expect(list[1]!.description).toBe('用户级的 alpha')
  })

  it('同名冲突：两条都在列表中；调用取项目级', () => {
    const { user, project, mgr } = make()
    mkdirSync(join(user, 'dup'), { recursive: true })
    writeFileSync(join(user, 'dup', 'SKILL.md'), '用户版正文')
    mkdirSync(join(project, 'dup'), { recursive: true })
    writeFileSync(join(project, 'dup', 'SKILL.md'), '项目版正文 $ARGUMENTS')
    expect(mgr.list()).toHaveLength(2)
    expect(mgr.forInvocation('dup', '参数X')).toBe('项目版正文 参数X')
  })

  it('create 生成骨架（目录 + SKILL.md，description 进 frontmatter）；非法名/重名拒绝', () => {
    const { mgr } = make()
    mgr.create('user', 'review', '代码评审')
    const path = mgr.list().find((s) => s.name === 'review')!
    expect(existsSync(path.path)).toBe(true)
    expect(path.description).toBe('代码评审')
    expect(mgr.read('user', 'review')).toContain('$ARGUMENTS')
    expect(() => mgr.create('user', 'Bad_Name', 'x')).toThrow(/名称/)
    expect(() => mgr.create('user', 'review', 'x')).toThrow(/已存在/)
  })

  it('update 整文件替换；remove 删目录且幂等', () => {
    const { mgr } = make()
    mgr.create('user', 'demo', 'd')
    mgr.update('user', 'demo', '---\ndescription: 新描述\n---\n新正文')
    expect(mgr.read('user', 'demo')).toContain('新正文')
    expect(mgr.list().find((s) => s.name === 'demo')!.description).toBe('新描述')
    mgr.remove('user', 'demo')
    expect(mgr.list().find((s) => s.name === 'demo')).toBeUndefined()
    expect(() => mgr.remove('user', 'demo')).not.toThrow() // 幂等
  })

  it('路径安全：目录名立法拒绝穿越与非法字符', () => {
    const { mgr } = make()
    expect(SKILL_NAME_RE.test('../evil')).toBe(false)
    expect(() => mgr.create('user', '../evil', 'x')).toThrow(/名称/)
    expect(() => mgr.remove('user', '..')).toThrow(/名称/)
    expect(() => mgr.read('user', 'Sub Dir')).toThrow(/名称/)
  })

  it('forInvocation：无占位且带参 → 追加说明段；未命中 → 抛错', () => {
    const { mgr } = make()
    mgr.create('user', 'plain', 'p')
    mgr.update('user', 'plain', '---\ndescription: p\n---\n纯指令正文')
    expect(mgr.forInvocation('plain', '额外要求')).toBe('纯指令正文\n\n用户参数：额外要求')
    expect(mgr.forInvocation('plain', '')).toBe('纯指令正文')
    expect(() => mgr.forInvocation('nope', '')).toThrow(/未找到/)
  })

  it('promptSection：无 skill 返回空串；有 skill 注入清单与读取引导', () => {
    const { mgr } = make()
    expect(mgr.promptSection()).toBe('')
    mgr.create('user', 'review', '代码评审')
    const section = mgr.promptSection()
    expect(section).toContain('## 可用 Skills')
    expect(section).toContain('review：代码评审')
    expect(section).toContain('read_file')
  })

  it('setProjectDir：项目级目录随 cwd 迁移', () => {
    const { root, mgr } = make()
    expect(mgr.list().filter((s) => s.scope === 'project')).toHaveLength(0)
    const proj2 = join(root, 'proj2')
    mkdirSync(join(proj2, '.dogegg', 'skills', 'moved'), { recursive: true })
    writeFileSync(join(proj2, '.dogegg', 'skills', 'moved', 'SKILL.md'), '---\ndescription: 搬家后\n---\nX')
    mgr.setProjectDir(proj2)
    expect(mgr.list().find((s) => s.name === 'moved')!.description).toBe('搬家后')
  })
})

describe('SkillsManager 启停与缺失态（M4.3）', () => {
  function makeSkill(dir: string, name: string, body: string): void {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), `---
name: ${name}
description: ${name} 的描述
---
${body}`)
  }

  it('toggle 停用：list 标记 enabled=false；状态文件落盘；promptSection 不再广告；forInvocation 拒绝', () => {
    const { user, mgr } = make()
    makeSkill(user, 'alpha', 'ALPHA_BODY')
    expect(mgr.list()[0]!.enabled).toBe(true)
    mgr.setEnabled('user', 'alpha', false)
    expect(mgr.list()[0]!.enabled).toBe(false)
    expect(mgr.list()[0]!.missing).toBe(false)
    expect(readFileSync(join(root!, '.skills.json'), 'utf8')).toContain('alpha')
    expect(mgr.promptSection()).not.toContain('alpha')
    expect(() => mgr.forInvocation('alpha', 'x')).toThrow(/停用或目录缺失/)
  })

  it('toggle 启用恢复：重新进入系统提示与调用', () => {
    const { user, mgr } = make()
    makeSkill(user, 'alpha', 'ALPHA_BODY')
    mgr.setEnabled('user', 'alpha', false)
    mgr.setEnabled('user', 'alpha', true)
    expect(mgr.list()[0]!.enabled).toBe(true)
    expect(mgr.promptSection()).toContain('alpha')
    expect(mgr.forInvocation('alpha', 'x')).toBe(`ALPHA_BODY

用户参数：x`)
  })

  it('缺失态：外部删除目录后 list 显示 missing 孤儿；启用即清理记录；promptSection 为空', () => {
    const { user, mgr } = make()
    makeSkill(user, 'gone', 'GONE_BODY')
    mgr.setEnabled('user', 'gone', false)
    rmSync(join(user, 'gone'), { recursive: true, force: true }) // 外部删除
    const list = mgr.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'gone', enabled: false, missing: true })
    expect(mgr.promptSection()).toBe('') // 孤儿不进系统提示
    mgr.setEnabled('user', 'gone', true) // 启用 = 清理孤儿记录
    expect(mgr.list()).toHaveLength(0)
  })

  it('同名覆盖：项目级停用时调用与广告回落用户级', () => {
    const { user, project, mgr } = make()
    makeSkill(user, 'dup', 'USER_BODY $ARGUMENTS')
    makeSkill(project, 'dup', 'PROJECT_BODY $ARGUMENTS')
    mgr.setEnabled('project', 'dup', false)
    expect(mgr.forInvocation('dup', 'x')).toContain('USER_BODY')
    const section = mgr.promptSection()
    // 广告里只剩用户级路径——项目级停用即退出竞争
    expect(section).toContain('user-skills')
    expect(section).not.toContain('.dogegg')
  })

  it('remove 清理停用名单：删除后无孤儿残留；create 同名重建默认启用', () => {
    const { user, mgr } = make()
    makeSkill(user, 'alpha', 'ALPHA_BODY')
    mgr.setEnabled('user', 'alpha', false)
    mgr.remove('user', 'alpha')
    expect(mgr.list()).toHaveLength(0)
    mgr.create('user', 'alpha', '重建')
    expect(mgr.list()).toEqual([{ name: 'alpha', description: '重建', scope: 'user', path: join(user, 'alpha', 'SKILL.md'), enabled: true, missing: false }])
  })
})
