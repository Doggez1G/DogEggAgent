import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { IGNORED_DIRS } from './ignore'

// 递归文件遍历器：glob / grep 的共用底座（能力文件夹，≥2 消费方故成立）。
// 只产出「posix 形式的相对路径」，内容读取归调用方（glob 不读内容、grep 读）——
// 遍历与消费分离让 walker 保持纯粹：不关心 pattern、不关心正则、不做 IO 之外的决策。
//
// 剪枝与跳过：
// - IGNORED_DIRS 按目录名剪枝（任意深度）——node_modules 这类目录整棵跳过，不进入；
// - symlink 一律跳过：目录 symlink 会造成环（a/link → a），文件 symlink 可能指到 root 之外，
//   两者都会让「遍历范围 = root 子树」的隐含承诺失效。工具探索不需要跟链接。
// - 取消：每个目录的处理间隙检查 ctx.signal（signal.throwIfAborted()），turn 取消能中断大仓库遍历。
export async function* walkFiles(
  rootDir: string,
  opts: {
    signal?: AbortSignal
    ignored?: ReadonlySet<string>
    /** 额外的路径谓词（如 .gitignore 匹配，见 ignore-gitignore.ts）——返回 true 则跳过该文件/目录。 */
    gitignore?: (relPath: string, isDir: boolean) => boolean
  } = {},
): AsyncGenerator<string> {
  const ignored = opts.ignored ?? IGNORED_DIRS
  // 迭代式 DFS：递归生成器在深层树上调用栈更浅，且中断检查点更规整。
  const stack: string[] = ['']
  while (stack.length > 0) {
    opts.signal?.throwIfAborted()
    const relDir = stack.pop()!
    const absDir = relDir === '' ? rootDir : join(rootDir, relDir)
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      continue // 无权限/已消失的目录跳过——遍历是探索性操作，单点失败不致命
    }
    // 排序保证遍历顺序跨平台确定：readdir 顺序依文件系统而异（NTFS 近字典序、ext4 哈希序），
    // 不排序则 grep 回执的命中顺序（及其测试）在 Linux 上不确定。
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const childDirs: string[] = []
    for (const e of sorted) {
      if (e.isSymbolicLink()) continue
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`
      if (e.isDirectory()) {
        if (ignored.has(e.name)) continue
        if (opts.gitignore?.(rel, true)) continue
        childDirs.push(rel)
      } else if (e.isFile()) {
        if (opts.gitignore?.(rel, false)) continue
        yield rel
      }
    }
    // 逆序压栈让产出顺序接近字母序（确定性对测试与回执可读性都重要）。
    for (let i = childDirs.length - 1; i >= 0; i--) stack.push(childDirs[i]!)
  }
}
