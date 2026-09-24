import { open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { z } from 'zod'
import { globToRegExp } from '@dogegg/bridge'
import type { Tool, ToolContext, ToolResult } from '../types'
import { walkFiles, isBinaryFile, loadGitIgnore } from '../traverse'
import { grepSchema, grepParameters } from './schema'

// ── 输出治理四层（设计 §3.3）──
// 搜索结果天然不可控：一次宽泛的正则在大仓库可能命中几十万行。四层递进保证回执有确定上界：
const MAX_LINE_LENGTH = 500      // ① 单行截断——压缩代码一行几千字符的情况（minified、长字符串字面量）
const MAX_HITS_PER_FILE = 20     // ② 单文件命中封顶——生成文件/数据文件里同一 pattern 密集出现
const MAX_TOTAL_HITS = 100       // ③ 总命中封顶——命中文件数本身失控
const MAX_OUTPUT_LENGTH = 8000   // ④ 总字符 cap——对齐 read_file 的回执先例，最坏情况上下文增量有界
const MAX_FILE_SIZE = 1024 * 1024 // 附带：超大文件跳过（1MB）——单文件全量读入内存且几乎不可能是目标代码
const BINARY_PROBE_BYTES = 8192  // 二进制探测深度：文本文件的前 8KB 几乎不可能含 NUL

// grep 工具：按内容搜索（正则逐行）。探索漏斗的最后一层，也是治理最严的工具。
//
// 回执格式 `相对路径:行号: 内容` 是「回执即契约」：UI formatter 按此前缀解析展示，
// 格式改动必须本工具与 ui/shared/tool-display 两处同步（对齐 edit_file 行号锚点先例）。
//
// 立法：matcher 复用 bridge 的 globToRegExp——glob 过滤参数与 glob 工具、权限参数化规则共享一份实现。
// glob 过滤对「完整相对路径」与「文件名」任一命中即通过：用户直觉里 `*.ts` 应匹配 src/x.ts
// （严格完整路径语义得写 **/*.ts），双匹配兼顾两种直觉。
export class GrepTool implements Tool {
  readonly name = 'grep'
  readonly description = '按正则在文件内容中逐行搜索（跨平台，不依赖 shell grep）；支持 glob 过滤与三种输出模式'
  readonly schema = grepSchema
  readonly parameters = grepParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path, glob, case_insensitive, output_mode } = args as z.infer<typeof grepSchema>

    let re: RegExp
    try {
      re = new RegExp(pattern, case_insensitive ? 'i' : '')
    } catch (e) {
      return { error: `无效的正则表达式 "${pattern}"：${String(e)}；请修正 pattern 后重试` }
    }

    let globRe: RegExp | undefined
    if (glob) {
      try {
        globRe = globToRegExp(glob)
      } catch (e) {
        return { error: `无效的 glob 过滤 "${glob}"：${String(e)}` }
      }
    }

    const root = path ? join(ctx.cwd, path) : ctx.cwd
    const rootStat = await stat(root).catch(() => null)
    if (!rootStat) return { error: `路径不存在：${path ?? '.'}` }

    // 单文件模式（path 指向文件）：产出一个空 rel，读 root 本身；目录模式：walkFiles 递归。
    // .gitignore（会话 cwd 根）参与过滤——用户项目的忽略意愿就是搜索的忽略意愿（M2.5）；
    // cwd 交给 walker 换算坐标，子根扫描时锚定规则才不双向失真（见 walker.ts 的 cwd 参数）。
    const gitignore = loadGitIgnore(ctx.cwd)
    const targets: AsyncIterable<string> = rootStat.isFile()
      ? (async function* singleFile() { yield '' })()
      : walkFiles(root, { signal: ctx.signal, gitignore, cwd: ctx.cwd })

    const mode = output_mode ?? 'content'
    const lines: string[] = []
    let totalHits = 0        // 命中总数（含未展示的）——决定 ③ 层截断说明
    let truncated = false    // ③ 或 ④ 层触发——尾部统一附截断说明
    let skippedLarge = 0
    let outputLength = 0

    // 第 ④ 层：总字符 cap。写满即置 truncated，后续写入一律拒绝（调用方据此提前结束遍历）。
    const pushLine = (line: string): boolean => {
      if (truncated || outputLength + line.length > MAX_OUTPUT_LENGTH) {
        truncated = true
        return false
      }
      lines.push(line)
      outputLength += line.length
      return true
    }

    const displayPathOf = (rel: string): string =>
      rel === '' ? (path ?? basename(root)) : rel

    collect: for await (const rel of targets) {
      ctx.signal.throwIfAborted()
      const abs = rel === '' ? root : join(root, rel)
      const displayPath = displayPathOf(rel)

      const info = await stat(abs).catch(() => null)
      if (!info || !info.isFile()) continue
      if (info.size > MAX_FILE_SIZE) { skippedLarge++; continue }

      // 先探 8KB 头判二进制（NUL 字节），命中则跳过——避免把二进制整份当 utf8 解码。
      if (await hasBinaryHead(abs)) continue
      let text: string
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue // 竞态删除/权限：单文件失败不致命
      }
      // glob 过滤只对遍历产物生效；path 指向具体文件时（rel === ''）glob 不参与过滤——
      // 显式点名即授权，否则 globRe.test('') 必败，点名文件恒被误过滤。
      if (globRe && rel !== '' && !globRe.test(rel) && !globRe.test(basename(rel))) continue

      // 逐行正则（\r 归一掉，Windows 行尾不影响命中与行号）。
      const fileLines = text.split('\n').map((l) => l.replace(/\r$/, ''))
      let fileHits = 0
      for (let i = 0; i < fileLines.length; i++) {
        if (!re.test(fileLines[i]!)) continue
        fileHits++
        totalHits++
        if (fileHits > MAX_HITS_PER_FILE) break // 第 ② 层：单文件封顶（停止扫描本文件）
        if (totalHits > MAX_TOTAL_HITS) { truncated = true; break collect } // 第 ③ 层：总命中封顶

        // 第 ① 层：单行截断。行写入可能触发 ④ 层——返回 false 即提前收场。
        // 文件级模式（files_with_matches/count）不产出行级输出，命中只计数，行在循环后统一产出。
        if (mode === 'content') {
          const clipped = fileLines[i]!.length > MAX_LINE_LENGTH
            ? fileLines[i]!.slice(0, MAX_LINE_LENGTH) + '…'
            : fileLines[i]!
          if (!pushLine(`${displayPath}:${i + 1}: ${clipped}`)) break collect
        }
      }

      // 收尾行：content 模式的单文件截断说明（② 层触发，且未被 ④ 层提前截场）。
      if (mode === 'content' && fileHits > MAX_HITS_PER_FILE && !truncated) {
        const unshown = countMatches(fileLines, re) - MAX_HITS_PER_FILE
        if (!pushLine(`${displayPath}（该文件还有 ${unshown} 处未显示）`)) break collect
      }
      if (mode !== 'content' && fileHits > 0) {
        const row = mode === 'files_with_matches' ? displayPath : `${displayPath}: ${fileHits}`
        if (!pushLine(row)) break collect
      }
    }

    if (lines.length === 0) {
      const note = skippedLarge > 0 ? `，已跳过 ${skippedLarge} 个超大文件` : ''
      return { content: `（无命中${note}）` }
    }

    if (truncated) {
      lines.push('（输出已截断，请用更具体的 pattern 或 glob 参数收窄搜索）')
    }
    if (skippedLarge > 0) lines.push(`（已跳过 ${skippedLarge} 个超过 1MB 的文件）`)
    return { content: lines.join('\n') }
  }
}

// 读文件首块（8KB）判是否含 NUL 字节；读失败按非二进制处理（随后的 readFile 自会给出 error 路径）。
async function hasBinaryHead(abs: string): Promise<boolean> {
  try {
    const fh = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(BINARY_PROBE_BYTES)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return isBinaryFile(buf.subarray(0, bytesRead))
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

// 统计一个文件里匹配的总行数——只为「该文件还有 N 处未显示」的补数（② 层 break 后剩余部分）。
function countMatches(fileLines: string[], re: RegExp): number {
  let n = 0
  for (const l of fileLines) if (re.test(l)) n++
  return n
}
