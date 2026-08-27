import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from '@dogegg/bridge'
import { configTargetPath } from './find'

// 把内存中的配置序列化写回 JSON（/config 编辑的持久化）；path 缺省走 configTargetPath()。
export function saveConfig(config: Config, path = configTargetPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}
