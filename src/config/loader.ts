import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { configSchema, type Config } from './schema'

// 定位配置：项目内 .dogegg.json 优先，否则 ~/.dogegg/config.json。
export function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
}

// 写回目标：已存在的配置优先，否则落到用户级默认路径（/config 编辑后落盘用）。
export function configTargetPath(): string {
  return findConfig() ?? join(homedir(), '.dogegg', 'config.json')
}

// raw 用于测试注入；运行时传 undefined 从文件加载。校验通过后再补默认 provider/model。
export function loadConfig(raw?: unknown): Config {
  let data: unknown
  if (raw !== undefined) {
    data = raw
  } else {
    const file = findConfig()
    if (!file) throw new Error('未找到配置文件（项目 .dogegg.json 或 ~/.dogegg/config.json）')
    data = JSON.parse(readFileSync(file, 'utf8'))
  }
  const parsed = configSchema.parse(data)
  const defaultProvider = parsed.defaultProvider ?? parsed.providers[0]!.name
  const provider = parsed.providers.find((p) => p.name === defaultProvider) ?? parsed.providers[0]!
  const defaultModel = parsed.defaultModel ?? provider.models[0]!.name
  return { ...parsed, defaultProvider, defaultModel }
}

// 把内存中的配置序列化写回 JSON（/config 编辑的持久化）；path 缺省走 configTargetPath()。
export function saveConfig(config: Config, path = configTargetPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}