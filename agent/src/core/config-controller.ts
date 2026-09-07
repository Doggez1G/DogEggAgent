import type { AgentToUiMessage, Config } from '@dogegg/bridge'
import type { BusyGate } from './busy-gate'
import type { ConfigEditor } from '../config/editor'
import type { ConfigStore } from '../config'

// 配置编辑控制器：config_set / config_add / config_remove / config_request 的实现归属。
// 编辑成功后的运行时联动（重建 PermissionManager / ContextAssembler）经 onConfigChanged 回调由 Agent 完成。
export class ConfigController {
  constructor(private readonly deps: {
    gate: BusyGate
    editor: ConfigEditor
    configs: ConfigStore
    emit: (m: AgentToUiMessage) => void
    onConfigChanged: (config: Config) => void
  }) {}

  request(): void {
    this.deps.emit({ type: 'config_state', config: this.deps.editor.getConfig() })
  }

  set(path: string, value: unknown): void {
    this.edit((e) => e.set(path, value))
  }

  add(path: string, value: unknown): void {
    this.edit((e) => e.add(path, value))
  }

  remove(path: string, index: number, providerIndex?: number): void {
    this.edit((e) => e.remove(path, index, providerIndex))
  }

  // 配置编辑统一入口：委托 ConfigEditor，成功后同步运行时 + 落盘 + emit。
  private edit(fn: (e: ConfigEditor) => { ok: boolean; error?: string }): void {
    if (this.deps.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候' }); return }
    const result = fn(this.deps.editor)
    if (!result.ok) {
      this.deps.emit({ type: 'notice', text: result.error ?? '配置编辑失败' })
      return
    }
    const config = this.deps.editor.getConfig()
    this.deps.onConfigChanged(config)
    this.deps.configs.save(config)
    this.deps.emit({ type: 'config_updated', config })
  }
}
