import { type ToolBodyLine } from './block'

// 工具调用展示格式化——TUI/WebUI 的唯一出处（单一知识单元：每个工具怎么呈现）。
// 输入是结构化事实（工具名/参数/输出/错误），输出是人类可读文案；
// 布局与视觉截断归渲染层，本模块只产出完整内容与逐行着色标记。
// 已知工具给专属分支（命令/路径/行数等主体信息），未知工具走 key=value 兜底。

// 展开正文行数上限——超大输出（如整文件写入）统一封顶，尾行标注剩余量。
const BODY_MAX_LINES = 200
// 编辑 diff 的上下文行数：变更前后公共首尾行各保留 2 行作对照。
const DIFF_CONTEXT = 2

// 折叠头行的参数段——每工具一个分支：直接给出人关心的主体，而非原始 JSON。
export function formatToolArgs(name: string, input: unknown): string {
  const inp = asRecord(input)
  switch (name) {
    case 'shell': return `$ ${String(inp.command ?? '')}`
    case 'read_file': return String(inp.path ?? '')
    case 'edit_file': {
      const stat = diffStat(String(inp.old_string ?? ''), String(inp.new_string ?? ''))
      return joinSegments([String(inp.path ?? ''), `+${stat.added} -${stat.removed}`])
    }
    case 'write_file':
      return joinSegments([String(inp.path ?? ''), `+${countLines(String(inp.content ?? ''))}`])
    default: return compactArgs(inp)
  }
}

// 折叠头行的结果段——done 给最低成本的量化信息（行数），失败给原因。
// null = 尚无结果（running 态），头行不显示结果段。
export function formatToolResult(name: string, output?: string, error?: string): string | null {
  if (error) {
    if (error === 'denied') return '已拒绝'
    return `✕ ${truncate(error, 60)}`
  }
  if (output === undefined) return null
  if (name === 'shell') {
    const parsed = parseShellContent(output)
    // exit≠0 是命令失败（✕ 标记驱动两端红色结果标签），成功则量化真实行数。
    if (parsed && parsed.exit !== 0) return `✕ 退出 ${parsed.exit}`
    return `${countLines(parsed ? parsed.body : output)} 行输出`
  }
  if (name === 'read_file') return `${countLines(output)} 行`
  return '完成'
}

// 折叠头行整行（name + 参数段 + 结果段）——reducer 存进 block.text，
// 供浏览模式等按单字符串消费的场景；渲染层需要分段截断时改调 args/result 两函数。
export function formatToolTitle(name: string, input: unknown, output?: string, error?: string): string {
  const args = formatToolArgs(name, input)
  const result = formatToolResult(name, output, error)
  return joinSegments([args ? `${name} ${args}` : name, ...(result ? [result] : [])], ' · ')
}

// 展开正文——每工具一个分支。kind 驱动渲染层着色（plain 正文色 / add 绿 / del 红 / cmd 弱化）。
export function formatToolBody(name: string, input: unknown, output?: string, error?: string): ToolBodyLine[] {
  if (error) {
    const lines: ToolBodyLine[] = [{ text: `✕ ${error}`, kind: 'plain' }]
    // 拒绝/失败也可能带部分结果（如 shell 超时前已产生的输出），有则附在错误之后。
    if (output) lines.push(...plainLines(output))
    return cap(lines)
  }
  const inp = asRecord(input)
  let lines: ToolBodyLine[]
  switch (name) {
    case 'edit_file':
      lines = diffLines(String(inp.old_string ?? ''), String(inp.new_string ?? ''))
      break
    case 'read_file':
      // 内容以编辑器式带行号呈现——行号是用户回看/引用文件时的天然坐标。
      lines = numberedLines(output ?? '')
      break
    case 'write_file':
      // 新文件内容同 read_file 的带行号呈现（头行 +N 已承载 diffstat，整篇标绿没有信息量）。
      lines = numberedLines(String(inp.content ?? ''))
      break
    case 'shell': {
      // 命令回显为 cmd 行（弱化）；content 首行 exit=N 是给模型判断成败的契约格式，
      // 展示层转换：exit=0 丢弃（✓ 已表达成功），超时说明保留为正文行。
      const parsed = output !== undefined ? parseShellContent(output) : null
      lines = [
        { text: `$ ${String(inp.command ?? '')}`, kind: 'cmd' },
        ...(parsed?.note ? [{ text: parsed.note, kind: 'plain' as const }] : []),
        ...(parsed ? plainLines(parsed.body) : plainLines(output ?? '')),
      ]
      break
    }
    default:
      lines = plainLines(output ?? '')
  }
  return lines.length > 0 ? cap(lines) : [{ text: '（无输出）', kind: 'plain' }]
}

// ── 内部：diff 统计与伪 unified diff ──

// 行级 diffstat：修剪公共首尾行后统计净增/净删行数（精确字符串替换的近似，非通用 diff）。
function diffStat(oldStr: string, newStr: string): { added: number; removed: number } {
  const { added, removed } = trimCommon(oldStr, newStr)
  return { added, removed }
}

// 伪 unified diff：公共首尾行各保留 DIFF_CONTEXT 行作上下文，中间净变更行 -旧 / +新。
function diffLines(oldStr: string, newStr: string): ToolBodyLine[] {
  const { oldLines, newLines, prefix, suffix } = trimCommon(oldStr, newStr)
  const lines: ToolBodyLine[] = []
  for (let i = Math.max(0, prefix - DIFF_CONTEXT); i < prefix; i++) lines.push({ text: `  ${oldLines[i]}`, kind: 'plain' })
  for (let i = prefix; i < oldLines.length - suffix; i++) lines.push({ text: `- ${oldLines[i]}`, kind: 'del' })
  for (let i = prefix; i < newLines.length - suffix; i++) lines.push({ text: `+ ${newLines[i]}`, kind: 'add' })
  for (let i = newLines.length - suffix; i < Math.min(newLines.length, newLines.length - suffix + DIFF_CONTEXT); i++) {
    lines.push({ text: `  ${newLines[i]}`, kind: 'plain' })
  }
  return lines
}

// 修剪公共首尾行——diffstat 与 diffLines 共用的核心：返回净变更区间。
function trimCommon(oldStr: string, newStr: string): {
  oldLines: string[]; newLines: string[]; prefix: number; suffix: number
  added: number; removed: number
} {
  const oldLines = oldStr === '' ? [] : oldStr.split('\n')
  const newLines = newStr === '' ? [] : newStr.split('\n')
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++
  return { oldLines, newLines, prefix, suffix, added: newLines.length - prefix - suffix, removed: oldLines.length - prefix - suffix }
}

// ── 内部：兜底与通用工具 ──

// 未知工具的参数兜底：key=value 紧凑形式（比原始 JSON 少一层符号噪音）。
function compactArgs(inp: Record<string, unknown>): string {
  const keys = Object.keys(inp)
  if (keys.length === 0) return ''
  return keys.map((k) => {
    const v = inp[k]
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    return `${k}=${truncate(s, 24)}`
  }).join(' ')
}

function plainLines(s: string): ToolBodyLine[] {
  const t = trimTrailingNewline(s)
  if (t === '') return []
  return t.split('\n').map((l) => ({ text: l, kind: 'plain' as const }))
}

// 内容行带 1-based 行号（no 字段）——渲染层画侧栏，复制不含行号。
function numberedLines(s: string): ToolBodyLine[] {
  const t = trimTrailingNewline(s)
  if (t === '') return [{ text: '（空文件）', kind: 'plain' }]
  return t.split('\n').map((l, i) => ({ text: l, no: i + 1, kind: 'plain' as const }))
}

// 尾随换行是命令输出/文件内容的常规形态，不构成一行（否则行数虚高——幻影空行）。
function trimTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

// shell content 首行固定为 exit=N（可带「（超时说明）」），是给模型判断成败的契约格式
//（agent/src/tools/shell）——展示层解析转换：退出码进头行结果段，说明与输出留在正文。
function parseShellContent(output: string): { exit: number; note: string; body: string } | null {
  const m = /^exit=(\d+)(.*)\n?/.exec(output)
  if (!m) return null
  return { exit: Number(m[1]), note: m[2] ?? '', body: output.slice(m[0].length) }
}

// 统一行数封顶——尾行标注剩余量（完整输出可经 TUI /log 或 WebUI Log Tail 卡片查看）。
function cap(lines: ToolBodyLine[]): ToolBodyLine[] {
  if (lines.length <= BODY_MAX_LINES) return lines
  return [...lines.slice(0, BODY_MAX_LINES), { text: `…（其余 ${lines.length - BODY_MAX_LINES} 行）`, kind: 'plain' }]
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {}
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function countLines(s: string): number {
  const t = trimTrailingNewline(s)
  return t === '' ? 0 : t.split('\n').length
}

// 连接非空片段（空片段跳过，避免残留孤立分隔符）。
function joinSegments(segments: string[], sep = ' '): string {
  return segments.filter((s) => s !== '').join(sep)
}
