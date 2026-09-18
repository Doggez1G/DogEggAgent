import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { configSchema, type Config } from '@dogegg/bridge'

// 定位配置文件：项目内 .dogegg.json 优先，否则 ~/.dogegg/config.json，都没有返回 null。
// （模块私有——外部只经 ConfigStore 存取，路径策略不外泄。）
function findConfig(): string | null {
  const local = join(process.cwd(), '.dogegg.json')
  if (existsSync(local)) return local
  const user = join(homedir(), '.dogegg', 'config.json')
  if (existsSync(user)) return user
  return null
}

// 写回目标路径：已存在的配置优先，否则落到用户级默认路径（/config 编辑后落盘用）。
function configTargetPath(): string {
  return findConfig() ?? join(homedir(), '.dogegg', 'config.json')
}

// 配置存取：读取（zod 校验 + 默认值填充）与落盘。路径策略为模块私有实现。
export class ConfigStore {
  // defaultPath：落盘目标的测试接缝——缺省走真实配置路径。⚠️ 凡会触发配置保存的测试
  //（config_set / mcp_manage 全局写）必须注入临时路径，否则会用测试数据覆写用户真实配置。
  constructor(private readonly defaultPath?: string) {}

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
  save(config: Config, path = this.defaultPath ?? configTargetPath()): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  }
}
