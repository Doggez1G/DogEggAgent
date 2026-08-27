import type { Config } from '@dogegg/bridge'
import { parseConfigSet, parseConfigAdd } from './paths'
import { applySet, applyAdd, applyRemove } from './mutate'
import { validateConfig } from './validate'

// 配置编辑门面：持有 config + 最后合法快照（lastGood）。
// 任何 set/add/remove 后统一重校验——失败回滚到 lastGood 并返回错误，由调用方决定 emit。
// 从旧 Agent 类抽出的 ~150 行配置编辑逻辑，归此独立成可测模块。
export class ConfigEditor {
  private lastGood: Config

  constructor(private config: Config) {
    this.lastGood = structuredClone(config)
  }

  getConfig(): Config {
    return this.config
  }

  set(path: string, value: unknown): { ok: boolean; error?: string } {
    const op = parseConfigSet(path, value)
    if (op) applySet(this.config, op)
    return this.afterEdit()
  }

  add(path: string, value: unknown): { ok: boolean; error?: string } {
    const op = parseConfigAdd(path, value)
    if (op) applyAdd(this.config, op)
    return this.afterEdit()
  }

  remove(path: string, index: number, providerIndex?: number): { ok: boolean; error?: string } {
    applyRemove(this.config, path, index, providerIndex)
    return this.afterEdit()
  }

  // 编辑后统一：重校验 + 重名检查；成功更新 lastGood，失败回滚到 lastGood。
  private afterEdit(): { ok: boolean; error?: string } {
    const result = validateConfig(this.config, this.lastGood)
    if (!result.ok) {
      this.config = structuredClone(result.config)
      return { ok: false, error: result.error }
    }
    this.config = result.config
    this.lastGood = structuredClone(this.config)
    return { ok: true }
  }
}
