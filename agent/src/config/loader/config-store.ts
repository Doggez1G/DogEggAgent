import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configSchema, type Config } from '@dogegg/bridge'
import { findConfig, configTargetPath } from './find'

// 配置存取：读取（zod 校验 + 默认值填充）与落盘。路径定位逻辑在同目录 find.ts（模块私有实现）。
export class ConfigStore {
  // raw 用于测试注入；运行时传 undefined 从文件加载。
  // 找不到配置文件时返回空配置（providers 为空），让程序能启动、引导用户去 /config。
  load(raw?: unknown): Config {
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
  save(config: Config, path = configTargetPath()): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  }
}
