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

// raw 用于测试注入；运行时传 undefined 从文件加载。
// 找不到配置文件时不再抛错，而是返回空配置（providers 为空），让工具能启动、引导用户去 /config。
export function loadConfig(raw?: unknown): Config {
  let data: unknown
  if (raw !== undefined) {
    data = raw
  } else {
    const file = findConfig()
    data = file ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  const parsed = configSchema.parse(data)
  // 仅在存在 provider 时补默认 provider/model；空配置保持无默认值。
  if (parsed.providers.length > 0) {
    const defaultProvider = parsed.defaultProvider ?? parsed.providers[0]!.name
    const provider = parsed.providers.find((p) => p.name === defaultProvider) ?? parsed.providers[0]!
    const defaultModel = parsed.defaultModel ?? provider.models[0]?.name
    return { ...parsed, defaultProvider, defaultModel: defaultModel ?? parsed.defaultModel }
  }
  return parsed
}

// 把内存中的配置序列化写回 JSON（/config 编辑的持久化）；path 缺省走 configTargetPath()。
export function saveConfig(config: Config, path = configTargetPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
}