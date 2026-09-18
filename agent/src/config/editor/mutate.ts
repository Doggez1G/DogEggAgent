import type { Config } from '@dogegg/bridge'
import type { ConfigSetOp, ConfigAddOp } from './paths'

// 对 config 对象执行 set 操作（原地变更）。越界 index 静默跳过（不抛错，与旧代码行为一致）。
export function applySet(config: Config, op: ConfigSetOp): void {
  switch (op.kind) {
    case 'top':
      if (op.field === 'defaultProvider' || op.field === 'defaultModel' || op.field === 'systemPrompt' || op.field === 'shellProgram') {
        config[op.field] = op.value as string
      } else {
        config[op.field] = op.value as number
      }
      break
    case 'permission':
      config.permission[op.bucket] = op.value
      break
    case 'provider': {
      const p = config.providers[op.index]
      if (!p) return
      ;(p as Record<string, unknown>)[op.field] = op.value // protocol 等枚举字段由 zod 校验兜底
      break
    }
    case 'model': {
      const m = config.providers[op.providerIndex]?.models[op.modelIndex]
      if (!m) return
      ;(m as Record<string, unknown>)[op.field] = op.value
      break
    }
  }
}

// 对 config 对象执行 add 操作（原地变更）。
export function applyAdd(config: Config, op: ConfigAddOp): void {
  if (op.kind === 'provider') {
    config.providers.push(op.value)
  } else {
    config.providers[op.providerIndex]?.models.push(op.value)
  }
}

// config_remove：'providers' 按 index 删 provider；'models' 按 index 删 model（providerIndex 定位 provider）。
export function applyRemove(config: Config, path: string, index: number, providerIndex?: number): void {
  if (path === 'providers') {
    config.providers.splice(index, 1)
  } else if (path === 'models' && providerIndex !== undefined) {
    config.providers[providerIndex]?.models.splice(index, 1)
  }
}
