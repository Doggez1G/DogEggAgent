import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { SkillsManager, PROMPT_SECTION_LIMIT } from '../../src/skills'

// ─────────────────────────────────────────────────────────────────────────────
// Skills 细节边界：$ARGUMENTS 的字面替换（防特殊序列改写）/ update 空内容防清空 /
// promptSection 条数上限（固定开销不挤占上下文窗口）。
// ─────────────────────────────────────────────────────────────────────────────

let root: string | null = null
afterEach(() => {
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
})

function make(): { user: string; mgr: SkillsManager } {
  root = mkdtempSync(join(tmpdir(), 'dogegg-skills-edge-'))
  const user = join(root, 'user-skills')
  const mgr = new SkillsManager(user)
  mgr.setProjectDir(join(root, 'proj')) // proj 目录不建 skill——本文件全部用用户级
  return { user, mgr }
}

function createUserSkill(user: string, name: string, body: string): void {
  mkdirSync(join(user, name), { recursive: true })
  writeFileSync(join(user, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的描述\n---\n${body}`)
}

describe('forInvocation：$ARGUMENTS 字面替换', () => {
  it('参数含 $$ $& $‘ 等特殊序列时按字面注入，不被 replaceAll 的替换模式改写', () => {
    const { user, mgr } = make()
    createUserSkill(user, 'template', '目标：$ARGUMENTS（完）')
    const args = '$$ $& $` $\''
    // 旧实现（字符串形态替换值）：$$ → $、$& → $ARGUMENTS、$' → 匹配位置之后的文本——参数被篡改。
    // 函数式替换：参数原样出现在结果里。
    expect(mgr.forInvocation('template', args)).toBe(`目标：${args}（完）`)
  })

  it('替换结果与参数完全一致（往返断言，防回归到字符串形态）', () => {
    const { user, mgr } = make()
    createUserSkill(user, 'echo', '$ARGUMENTS')
    for (const args of ['$$', '$&', "$'", 'a$$b', '$$ $&']) {
      expect(mgr.forInvocation('echo', args)).toBe(args)
    }
  })
})

describe('update 防清空', () => {
  it('content 为空串直接 throw，文件保持原样', () => {
    const { user, mgr } = make()
    createUserSkill(user, 'demo', '原始正文')
    expect(() => mgr.update('user', 'demo', '')).toThrow(/SKILL\.md 内容不能为空/)
    expect(mgr.read('user', 'demo')).toContain('原始正文')
  })

  it('非空内容照常整文件替换', () => {
    const { user, mgr } = make()
    createUserSkill(user, 'demo', '原始正文')
    mgr.update('user', 'demo', '---\ndescription: 新\n---\n新正文')
    expect(readFileSync(join(user, 'demo', 'SKILL.md'), 'utf8')).toContain('新正文')
  })
})

describe('promptSection 条数上限', () => {
  it(`超过 ${PROMPT_SECTION_LIMIT} 条只列前 ${PROMPT_SECTION_LIMIT} 条并追加溢出提示行`, () => {
    const { user, mgr } = make()
    for (let i = 0; i < 65; i++) createUserSkill(user, `skill-${String(i).padStart(2, '0')}`, `正文${i}`)
    const section = mgr.promptSection()
    const listed = section.split('\n').filter((l) => l.startsWith('- '))
    expect(listed).toHaveLength(PROMPT_SECTION_LIMIT)
    expect(section).toContain('…另有 5 个 skill 未列出（完整清单见 /skills）')
  })

  it('未超上限时不追加溢出提示行', () => {
    const { user, mgr } = make()
    createUserSkill(user, 'only', '正文')
    const section = mgr.promptSection()
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
    expect(section).not.toContain('未列出')
  })
})
