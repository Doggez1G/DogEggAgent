import { readFileSync } from 'node:fs'
import { configSchema, type Config } from '@dogegg/bridge'
import { findConfig } from './find'

// raw 用于测试注入；运行时传 undefined 从文件加载。
// 找不到配置文件时返回空配置（providers 为空），让工具能启动、引导用户去 /config。
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
