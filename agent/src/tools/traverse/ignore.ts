// 递归遍历的忽略规则——glob / grep 共用（ls 不适用：用户点名看的目录应如实呈现，见设计 §5）。
// 立法：这是「内置黑名单」策略而非完整 .gitignore 解析（嵌套/取反是独立后续批次）——
// 黑名单覆盖 node_modules 等构建产物的 90% 痛点，且零解析成本、行为可穷举测试。

// 递归剪枝的目录名：按名字匹配（任意深度），不按路径。
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.dogegg',
])

// 二进制文件判定：读文件首块，含 \0 字节即视为二进制（文本文件几乎不可能出现 NUL）。
// 刻意不依赖扩展名白名单——扩展名枚举不完（无后缀的可执行、奇怪的数据文件），
// 内容判定一条规则覆盖全部；误判代价是少搜一个文件，方向安全。
export function isBinaryFile(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte === 0) return true
  }
  return false
}
