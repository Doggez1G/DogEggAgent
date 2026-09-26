import { describe, it, expect } from 'vitest'
import { parseSkillMd, skeletonSkillMd } from '../../src/skills'

// ─────────────────────────────────────────────────────────────────────────────
// parseSkillMd 单测（此前零覆盖）：frontmatter 边界——尤其「无尾换行」场景：
// 闭合 --- 是文件最后一行时其后没有 \n，旧实现 slice(0) 会把 frontmatter 混进正文。
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSkillMd', () => {
  it('无尾换行：闭合 --- 为最后一行时 body 为空，frontmatter 不混入正文', () => {
    const parsed = parseSkillMd('---\nname: a\ndescription: 测试技能\n---')
    expect(parsed.description).toBe('测试技能')
    expect(parsed.body).toBe('')
  })

  it('正常文件：提取 description，body 取闭合 --- 之后', () => {
    const parsed = parseSkillMd('---\ndescription: 打印问候\n---\n正文指令第一行\n第二行')
    expect(parsed.description).toBe('打印问候')
    expect(parsed.body).toBe('正文指令第一行\n第二行')
  })

  it('无 frontmatter：整段作为 body，description 为空', () => {
    const parsed = parseSkillMd('直接正文，没有 frontmatter')
    expect(parsed.description).toBe('')
    expect(parsed.body).toBe('直接正文，没有 frontmatter')
  })

  it('无闭合 ---：视为无 frontmatter，整段作为 body', () => {
    const raw = '---\nname: a\ndescription: 未闭合\n正文'
    const parsed = parseSkillMd(raw)
    expect(parsed.description).toBe('')
    expect(parsed.body).toBe(raw.trim())
  })

  it('CRLF 归一：\r\n 文件的 frontmatter 照常解析', () => {
    const parsed = parseSkillMd('---\r\ndescription: 换行符\r\n---\r\n正文')
    expect(parsed.description).toBe('换行符')
    expect(parsed.body).toBe('正文')
  })

  it('骨架文件（生成器的产物，带尾换行）可往返解析', () => {
    const parsed = parseSkillMd(skeletonSkillMd('demo', '演示技能'))
    expect(parsed.description).toBe('演示技能')
    expect(parsed.body).toContain('$ARGUMENTS')
  })

  // ── P2-15 定界符严格化：闭合 --- 必须是独立行；先剥 UTF-8 BOM ──

  it('P2-15 正文含 "----" 行：不误判为闭合，"----" 保留在 body', () => {
    const parsed = parseSkillMd('---\ndescription: 分隔线测试\n---\n正文一\n----\n正文二')
    expect(parsed.description).toBe('分隔线测试')
    expect(parsed.body).toBe('正文一\n----\n正文二')
  })

  it('P2-15 正文含 "--- text" 行：不误判为闭合，整行保留在 body', () => {
    const parsed = parseSkillMd('---\ndescription: 备注测试\n---\n先看这里\n--- text 是普通文本行\n结尾')
    expect(parsed.description).toBe('备注测试')
    expect(parsed.body).toBe('先看这里\n--- text 是普通文本行\n结尾')
  })

  it('P2-15 UTF-8 BOM 开头（兼 CRLF）：剥 BOM 后 frontmatter 照常解析', () => {
    // 旧实现不剥 BOM → startsWith('---\n') 恒假 → frontmatter 整体失效（description 丢失）。
    const parsed = parseSkillMd('\uFEFF---\r\ndescription: 带 BOM 的技能\r\n---\r\n正文')
    expect(parsed.description).toBe('带 BOM 的技能')
    expect(parsed.body).toBe('正文')
  })

  it('P2-15 只有 "----" 可当「闭合」：不合法 → 无 frontmatter，整文件当 body', () => {
    // 旧实现 indexOf('\n---') 会把 "----" 行的前缀误当闭合，把正文截进 frontmatter——
    // 新实现找不到独立行的 "---" 即整体视为无 frontmatter（容错方向：不吞正文）。
    const raw = '---\nname: a\ndescription: 未闭合\n----\n正文'
    const parsed = parseSkillMd(raw)
    expect(parsed.description).toBe('')
    expect(parsed.body).toBe(raw.trim())
  })
})
