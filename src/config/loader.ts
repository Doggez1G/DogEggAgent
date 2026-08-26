import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configSchema, type Config } from './schema'

function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
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