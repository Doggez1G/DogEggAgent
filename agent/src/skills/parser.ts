// SKILL.md 最小 frontmatter 解析（Agent Skills 规范子集）：
//   ---
//   name: xxx        ← 仅文档性；skill 名以目录名为唯一事实源（见 manager 立法）
//   description: xxx ← 渐进披露的关键：模型与面板靠这行字判断何时使用
//   ---
//   正文指令……
// 不引 YAML 依赖——只取 frontmatter 块内「key: value」单行键值，其余键忽略。
export interface ParsedSkillMd {
  description: string
  body: string
}

export function parseSkillMd(raw: string): ParsedSkillMd {
  const normalized = raw.replace(/\r\n/g, '\n')
  // frontmatter 块：首行必须是 ---，且存在闭合 ---。
  if (!normalized.startsWith('---\n')) return { description: '', body: normalized.trim() }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { description: '', body: normalized.trim() }
  const head = normalized.slice(4, end)
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1).trim()
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
