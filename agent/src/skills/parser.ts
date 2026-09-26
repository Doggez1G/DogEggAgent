// SKILL.md 最小 frontmatter 解析（Agent Skills 规范子集）：
//   ---
//   name: xxx        ← 仅文档性；skill 名以目录名为唯一事实源（见 manager 立法）
//   description: xxx ← 渐进披露的关键：模型与面板靠这行字判断何时使用
//   ---
//   正文指令……
// 不引 YAML 依赖——只取 frontmatter 块内「key: value」单行键值，其余键忽略。
//
// 定界符立法（P2-15）：闭合 --- 必须是【独立行】（行级扫描，而非子串 indexOf）——
// 子串匹配会把正文中的 '----'、'--- text' 等行误当闭合定界符，把正文截进 frontmatter。
// 找不到合法闭合 → 无 frontmatter（整文件当正文，维持容错方向：解析失败不吞正文）。
// BOM 立法：Windows 编辑器常给 UTF-8 文件加 BOM——不剥掉则 startsWith('---\n') 恒假，
// frontmatter 整体失效（description 丢失），所以必须先剥 BOM 再解析。
export interface ParsedSkillMd {
  description: string
  body: string
}

export function parseSkillMd(raw: string): ParsedSkillMd {
  // BOM（U+FEFF）只出现在文件头，先剥再归一化换行。
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  // frontmatter 块：首行必须是 ---，且存在作为独立行的闭合 ---。
  if (!normalized.startsWith('---\n')) return { description: '', body: normalized.trim() }
  const lines = normalized.split('\n')
  // 从第 1 行（跳过开头的 --- 行）起找第一条恰好为 '---' 的行——'----'、'--- text' 都不是定界符。
  const closeIdx = lines.findIndex((line, i) => i > 0 && line === '---')
  if (closeIdx < 0) return { description: '', body: normalized.trim() }
  const head = lines.slice(1, closeIdx).join('\n')
  const body = lines.slice(closeIdx + 1).join('\n').trim()
  let description = ''
  for (const line of head.split('\n')) {
    const m = /^description:\s*(.*)$/.exec(line)
    if (m) { description = m[1]!.trim(); break }
  }
  return { description, body }
}

// 由 name + description 生成骨架 SKILL.md——「增」的产物：格式正确、立即可用，正文留给用户充实。
export function skeletonSkillMd(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `使用 $ARGUMENTS 作为用户传入的参数。`,
    '',
    '（在此写下交给模型的完整指令……）',
    '',
  ].join('\n')
}
