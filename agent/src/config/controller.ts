import type { AgentToUiMessage, Config } from '@dogegg/bridge'
import type { ConfigEditor } from './editor'
import type { ConfigStore } from './store'
import type { AgentContext } from '../ctx'

// 配置编辑控制器：config_set / config_add / config_remove / config_request 的实现归属。
// 编辑成功后的运行时联动（重建 PermissionManager / ContextAssembler）经 onConfigChanged 回调由 Agent 完成。
export class ConfigController {
  constructor(private readonly deps: {
    ctx: AgentContext
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

  // mcpServers 整组替换（/mcp 面板全局写入原语）——与 set/add/remove 同一条 edit 链路
  //（gate 阻塞 / zod 校验 / 落盘 / config 广播 / onConfigChanged 运行时联动）。
  replaceMcpServers(servers: Config['mcpServers']): void {
    this.edit((e) => e.setMcpServers(servers))
  }

  // 配置编辑统一入口：委托 ConfigEditor，成功后落盘 + 同步运行时 + emit。
  // 顺序立法（先落盘、再联动运行时、最后广播）：save 抛错会被上层 send 的 .catch 静默吞掉，
  // 若先 onConfigChanged（运行时已换新）再 save，磁盘上仍是旧配置——运行态与磁盘分叉，
  // 重启后「修改消失」。因此磁盘成功才允许运行时与 UI 看到：save 抛错只发 notice，
  // 不换运行时、不发 config_updated（编辑器内存态保持编辑后值，后续编辑在其上继续，可再重试落盘）。
  private edit(fn: (e: ConfigEditor) => { ok: boolean; error?: string }): void {
    // busy/失败 notice 带 channel: 'config'——WebUI 设置面板 inline 可见（枚举由 WP2 扩 'config'，
    // 此处先行接入；类型报错待 WP2 收口）。
    if (this.deps.ctx.gate.busy) { this.deps.emit({ type: 'notice', text: '运行中，请稍候', channel: 'config' }); return }
    const result = fn(this.deps.editor)
    if (!result.ok) {
      this.deps.emit({ type: 'notice', text: result.error ?? '配置编辑失败', channel: 'config' })
      // 失败补发 config_updated（回滚后的 lastGood 快照）：失败不广播的话，WebUI 表单里
      // 已输入的非法值会继续显示，与内存/磁盘的真实值分叉——用户以为改成功了。
      this.deps.emit({ type: 'config_updated', config: this.deps.editor.getConfig() })
      return
    }
    const config = this.deps.editor.getConfig()
    try {
      this.deps.configs.save(config)
    } catch {
      // 落盘失败（磁盘错误？）：本次修改不生效——不发 config_updated，WebUI 表单保留用户输入可重试。
      this.deps.emit({ type: 'notice', text: '配置保存失败（磁盘错误？），本次修改未生效', channel: 'config' })
      return
    }
    this.deps.onConfigChanged(config)
    this.deps.emit({ type: 'config_updated', config })
  }
}
