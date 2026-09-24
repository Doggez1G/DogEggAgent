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

// 对 config 对象执行 add 操作（原地变更）。返回结果约定：越界/无匹配返回 { ok: false, error }
//（调用方 editor 直接透传给 notice，不再像旧实现那样静默 no-op 后判 ok——「什么都没发生却报告成功」
// 会让编辑端与真实 config 分叉）。
export function applyAdd(config: Config, op: ConfigAddOp): { ok: boolean; error?: string } {
  if (op.kind === 'provider') {
    config.providers.push(op.value)
    return { ok: true }
  }
  const provider = config.providers[op.providerIndex]
  if (!provider) return { ok: false, error: `provider 索引越界：${op.providerIndex}（共 ${config.providers.length} 个）` }
  provider.models.push(op.value)
  return { ok: true }
}

// config_remove：'providers' 按 index 删 provider；'models' 按 index 删 model（providerIndex 定位 provider）。
// 越界（index 非整数 / 负数 / 超出数组长度）与 provider 定位失败都返回 { ok: false, error }——
// 不再静默跳过（旧实现越界 splice 直接无效，编辑端无从得知删除没发生）。
export function applyRemove(config: Config, path: string, index: number, providerIndex?: number): { ok: boolean; error?: string } {
  if (path === 'providers') {
    if (!Number.isInteger(index) || index < 0 || index >= config.providers.length) {
      return { ok: false, error: `provider 索引越界：${index}（共 ${config.providers.length} 个）` }
    }
    config.providers.splice(index, 1)
    return { ok: true }
  }
  if (path === 'models' && providerIndex !== undefined) {
    const provider = config.providers[providerIndex]
    if (!provider) return { ok: false, error: `provider 索引越界：${providerIndex}（共 ${config.providers.length} 个）` }
    if (!Number.isInteger(index) || index < 0 || index >= provider.models.length) {
      return { ok: false, error: `model 索引越界：${index}（provider「${provider.name}」共 ${provider.models.length} 个模型）` }
    }
    provider.models.splice(index, 1)
    return { ok: true }
  }
  return { ok: false, error: `无效的删除路径：${path}` }
}
