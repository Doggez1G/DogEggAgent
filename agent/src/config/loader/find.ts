import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 定位配置文件：项目内 .dogegg.json 优先，否则 ~/.dogegg/config.json，都没有返回 null。
export function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
}

// 写回目标路径：已存在的配置优先，否则落到用户级默认路径（/config 编辑后落盘用）。
export function configTargetPath(): string {
  return findConfig() ?? join(homedir(), '.dogegg', 'config.json')
}
