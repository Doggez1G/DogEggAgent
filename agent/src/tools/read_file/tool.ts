import { readFile, stat } from 'node:fs/promises'
import type { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types'
import { isBinaryFile } from '../traverse'
import { resolveTargetPath } from '../../shared'
import { readFileSchema, readFileParameters } from './schema'

// 读取上限立法：与 grep 的 1MB/文件防护对齐——超大文件整份读进内存既可能 OOM，
// 也会一次性灌爆上下文。先 stat 拦下，指引模型改走「grep 定位 → 再读」的探索漏斗。
const READ_FILE_MAX_BYTES = 1024 * 1024

// 二进制探测深度：前 8KB——与 grep 的 BINARY_PROBE_BYTES 同一口径（8192，见 grep/tool.ts），
// 文本文件的前 8KB 几乎不可能出现 NUL 字节。判定函数直接复用 traverse 的 isBinaryFile
//（含 NUL 即二进制，不依赖扩展名——扩展名枚举不完，内容判定一条规则覆盖全部，
// 误判代价是少读一个文件、方向安全），read_file 与 grep 对同一文件必须给出同一结论：
// grep 跳过的文件 read_file 也该拒绝读，否则「grep 说是二进制、read_file 吐乱码」自相矛盾。
const BINARY_PROBE_BYTES = 8192

// read_file 工具：读取文件内容（相对 cwd）。
// 失败返回 error 串而非抛错——工具错误不中断 loop，而是作为 tool 消息回填模型。
export class ReadFileTool implements Tool {
  readonly name = 'read_file'
  readonly description = '读取文件内容'
  readonly schema = readFileSchema
  readonly parameters = readFileParameters

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path } = args as z.infer<typeof readFileSchema>
    // P3 绝对路径立法：一律走 resolveTargetPath 而非 join——Windows 上 join(cwd, 绝对路径)
    // 会把盘符冒号吞掉产生乱码路径（ENOENT），绝对参数（模型从回执里复制的路径常是绝对形式）
    // 必须原样 resolve；相对路径基于 cwd resolve（详见 shared/target-path.ts 立法）。
    const p = resolveTargetPath(ctx.cwd, path)
    try {
      const info = await stat(p)
      if (info.size > READ_FILE_MAX_BYTES) {
        return { error: `文件超过 1MB（${info.size} 字节），请改用 grep 定位后再读取所需片段` }
      }
      // P2-13 二进制/BOM 立法：先读原始 Buffer（不用 readFile(p, 'utf8') 直出字符串）——
      // ① 二进制探测必须发生在解码之前：整份按 utf8 解码后 NUL 已变成 \u0000 混在字符串里，
      //    乱码会整段灌进上下文，且与 grep 的「二进制跳过」口径脱节；
      // ② BOM 剥离必须在解码之后按字符串处理：UTF-8 BOM（EF BB BF）解码后就是首字符 \uFEFF，
      //    留着会污染首行内容与后续按行解析（模型常把 BOM 当内容的一部分复述出去）。
      const buf = await readFile(p)
      const head = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES))
      if (isBinaryFile(head)) {
        return { error: '二进制文件，未读取内容（请确认文件类型，或用 grep/glob 定位文本文件）' }
      }
      const text = buf.toString('utf8')
      return { content: text.startsWith('\uFEFF') ? text.slice(1) : text }
    } catch (e) {
      return { error: String(e) }
    }
  }
}
