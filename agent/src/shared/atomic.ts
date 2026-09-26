import { renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { rename, writeFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

// 原子落盘原语（tmp + rename）——崩溃 / 断电 / 磁盘满安全的文件写入。
//
// 立法（为什么必须 tmp + rename，而不是直接 write）：
// - 直接 writeFile/writeFileSync 是「先截断目标文件、再写入内容」两步操作——中途进程崩溃、
//   断电或磁盘满，目标文件就停留在被截断的半截内容上。配置、会话存档、源码文件损坏的
//   往往是唯一副本，无法自愈。
// - Windows（NTFS）与 POSIX 上，「同目录 rename 覆盖已存在目标」都是原子操作：观察者要么
//   看到完整的旧文件、要么看到完整的新文件，不存在中间态。因此先写临时文件、再 rename
//   覆盖目标，可把「半写损坏」窗口收敛为零。
// - 临时文件必须与目标【同目录】：跨盘符（不同卷）的 rename 在 Windows 上退化为
//   「复制 + 删除」，失去原子性，等于白做。
// - tmp 名含 pid 与随机后缀：两个进程（或同进程两个并发写）写同一目标时若共用固定 tmp 名
//   （如 target + '.tmp'），A 刚写完 B 就覆盖，再各自 rename 会互相踩——pid 隔离进程，
//   随机后缀隔离同进程并发。
function tmpNameFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
}

// 失败清理：写 tmp 或 rename 失败时把 tmp 删掉，不留垃圾文件（清理本身尽力而为——
// tmp 可能根本没建成，二次失败直接吞掉，不掩盖原始错误）。
function cleanupSync(tmp: string): void {
  try { unlinkSync(tmp) } catch { /* tmp 不存在等——清理尽力而为 */ }
}

// 同步版：目录内的 config / .skills.json / .mcp.json 等小文件落盘用。
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = tmpNameFor(filePath)
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, filePath)
  } catch (e) {
    cleanupSync(tmp)
    throw e
  }
}

// 异步版：工具层（async execute）落盘用——与 node:fs/promises 同签名，便于原地替换。
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmp = tmpNameFor(filePath)
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, filePath)
  } catch (e) {
    await unlink(tmp).catch(() => { /* 清理尽力而为 */ })
    throw e
  }
}
