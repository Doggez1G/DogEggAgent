import { readdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'

// 安全目录浏览：默认只返回子目录（不返回文件），避免泄露文件内容。
// includeFiles=true 时也返回文件名（用于 system prompt 文件选择器）。
// 返回 current（当前目录绝对路径）、dirs（子目录名列表）、files（文件名列表，可选）、parent（上级目录路径或 null）。
export async function listDirs(path: string, includeFiles = false): Promise<{ current: string; dirs: string[]; files: string[]; parent: string | null }> {
  const current = resolve(path)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    // 目录不存在或无权限——返回空列表让 UI 显示空状态。
    return { current, dirs: [], files: [], parent: dirname(current) !== current ? dirname(current) : null }
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  const files = includeFiles
    ? entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    : []
  const parent = dirname(current) !== current ? dirname(current) : null
  return { current, dirs, files, parent }
}

// 拼接路径用于 fs handler——从 query string 取 path 参数，缺省用 process.cwd()。
export function resolveFsPath(pathParam: string | undefined): string {
  return pathParam ? resolve(pathParam) : process.cwd()
}
