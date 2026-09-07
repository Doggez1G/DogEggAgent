import type { Key } from 'ink'
import type { Config, UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'
import { buildEntries } from './build'
import { parentPath } from './navigation'
import type { TreeCtx } from './entries'

export interface ConfigKeysApi {
  setView(view: View): void
  getConfig(): Config | null
  treeCtx: TreeCtx
}

// 配置编辑器按键：↑↓ 选 entry，←→ 切布尔/返回上级，回车按 entry 类型分派，
// esc 逐级返回（根层关闭），d 删除（del 后留在同页并 clamp cursor 防越界）。
export function handleConfigKeys(v: Extract<View, { kind: 'config' }>, key: Key, inputChar: string, api: ConfigKeysApi): void {
  const cfg = api.getConfig()
  const entries = cfg ? buildEntries(cfg, v.path, api.treeCtx) : []
  const entry = entries[v.cursor]
  const len = Math.max(1, entries.length)
  if (key.upArrow) api.setView({ ...v, cursor: (v.cursor - 1 + len) % len, preview: null })
  else if (key.downArrow) api.setView({ ...v, cursor: (v.cursor + 1) % len, preview: null })
  else if (key.leftArrow || key.rightArrow) {
    if (entry?.kind === 'bool') api.setView({ ...v, preview: !(v.preview ?? entry.value) })
    else api.setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null })
  } else if (key.return) {
    if (entry?.kind === 'goto') api.setView({ kind: 'config', path: entry.subPath, cursor: 0, preview: null })
    else if (entry?.kind === 'scalar') api.setView({ kind: 'prompt', title: `输入 ${entry.label}`, value: entry.value, returnPath: v.path, returnCursor: v.cursor, onSubmit: (val) => { entry.save(val); api.setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
    else if (entry?.kind === 'prompt') api.setView({ kind: 'prompt', title: entry.title, value: '', returnPath: v.path, returnCursor: v.cursor, onSubmit: (val) => { entry.save(val); api.setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) } })
    else if (entry?.kind === 'bool') { entry.save(v.preview ?? entry.value); api.setView({ kind: 'config', path: v.path, cursor: v.cursor, preview: null }) }
    else if (entry?.kind === 'action') {
      entry.run()
      // 操作后的导航行为：
      // - 有 del 的 action（按 Enter 删除）：返回父层（项已删，不留空页）
      // - 无 del 的 action（选择/添加）：留在同页，cursor 不变
      if (entry.del) {
        api.setView({ kind: 'config', path: parentPath(v.path) ?? { kind: 'root' }, cursor: 0, preview: null })
      }
    }
  } else if (key.escape) {
    const parent = parentPath(v.path)
    if (parent) api.setView({ kind: 'config', path: parent, cursor: 0, preview: null })
    else api.setView({ kind: 'none' })
  } else if (inputChar === 'd' && entry) {
    // d 键删除：执行 del 后留在同页，clamp cursor 防越界（删最后一项时 cursor 回退）。
    if ((entry.kind === 'goto' || entry.kind === 'action') && entry.del) {
      entry.del()
      api.setView({ ...v, cursor: Math.min(v.cursor, Math.max(0, entries.length - 2)), preview: null })
    }
  }
}
