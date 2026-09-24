import { existsSync } from 'node:fs'
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

// 校验 + 重名检查 + systemPrompt 路径存在性检查。失败返回回滚后的合法快照 + 错误信息；
// 成功返回 zod parse 后的 config（并入默认值）。调用方据此决定是否 emit error + 回滚。
export function validateConfig(config: Config, lastGood: Config): { ok: true; config: Config } | { ok: false; config: Config; error: string } {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) {
    return { ok: false, config: lastGood, error: '配置校验失败，已回滚：' + (parsed.error.issues[0]?.message ?? '') }
  }
  const dup = findDuplicateName(parsed.data)
  if (dup) {
    return { ok: false, config: lastGood, error: '名称重复，已回滚：' + dup }
  }
  // systemPrompt 路径存在性（编辑期拦截）：加载侧 loadSystemPrompt 对失效路径回退内置默认
  // （运行时可用性优先，不炸每一轮请求）——但那会让用户配置「静默不生效」。写入时就校验
  // existsSync，路径不存在/不可读直接拒绝并回滚 + notice，错误在配置面板原地可见。
  const sp = parsed.data.systemPrompt
  if (sp && !existsSync(sp)) {
    return { ok: false, config: lastGood, error: `systemPrompt 路径不存在或不可读取，已回滚：${sp}` }
  }
  return { ok: true, config: parsed.data }
}
