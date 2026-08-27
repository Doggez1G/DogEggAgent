import { configSchema, type Config } from '@dogegg/bridge'

// 返回重复的 provider/model 名。仅非空名判重——编辑期的新空节点（name 为空）允许多个共存。
export function findDuplicateName(config: Config): string | null {
  const seen = new Set<string>()
  for (const p of config.providers) {
    if (p.name) {
      if (seen.has(p.name)) return `provider「${p.name}」`
      seen.add(p.name)
    }
    const models = new Set<string>()
    for (const m of p.models) {
      if (m.name) {
        if (models.has(m.name)) return `model「${m.name}」`
        models.add(m.name)
      }
    }
  }
  return null
}

// 校验 + 重名检查。失败返回回滚后的合法快照 + 错误信息；成功返回 zod parse 后的 config（并入默认值）。
// 调用方据此决定是否 emit error + 回滚。
export function validateConfig(config: Config, lastGood: Config): { ok: true; config: Config } | { ok: false; config: Config; error: string } {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) {
    return { ok: false, config: lastGood, error: '配置校验失败，已回滚：' + (parsed.error.issues[0]?.message ?? '') }
  }
  const dup = findDuplicateName(parsed.data)
  if (dup) {
    return { ok: false, config: lastGood, error: '名称重复，已回滚：' + dup }
  }
  return { ok: true, config: parsed.data }
}
