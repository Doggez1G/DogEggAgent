import { useCallback, useRef } from 'react'
import { useInput } from 'ink'
import type { Config, UiPort } from '@dogegg/bridge'
import type { Block, ChatState } from '../../shared'
import type { TreeCtx } from '../features/config'
import { handlePermissionKeys } from '../features/permission/keys'
import { handleMenuKeys } from '../features/menu/keys'
import { handlePromptKeys } from '../features/prompt/keys'
import { handleSessionPickerKeys } from '../features/sessions/keys'
import { handleConfigKeys } from '../features/config/keys'
import { handleSuggestionKeys, handleHistoryKeys, handlePathSuggestKeys } from '../features/input/keys'
import { matchPathToken, applyPathCompletion } from '../features/input'
import { handleBrowseKeys } from '../features/browse/keys'
import { handleInfoKeys } from '../features/info/keys'
import { resetSigintTimer } from './entry'
import type { View } from '../view-state'

export interface KeyRoutingDeps {
  port: UiPort
  /** View 的 ref 镜像——Ink useInput 回调里读 state 会拿到旧值，必须走 ref（历史教训）。 */
  viewRef: { current: View }
  setView(view: View): void
  statusRef: { current: ChatState['status'] }
  configRef: { current: Config | null }
  treeCtx: TreeCtx
  input: string
  setInput(value: string): void
  /** 会话 cwd——@path 联想的候选来源（仅 cwd 内提供补全）。 */
  cwd: string | undefined
  /** @path 弹框已 Esc 关闭（输入变化前不再弹出/拦截按键）。 */
  pathDismissed: boolean
  dismissPathSuggest(): void
  suggest: { get(): number | null; set(value: number | null): void }
  browse: {
    get(): number | null
    set(value: number | null): void
    blocks(): Block[]
    isExpanded(index: number): boolean
    toggle(index: number): void
  }
  infoScroll(updater: (s: number) => number): void
  history: { items: string[]; cursor: number; setCursor(cursor: number): void }
  /** 折叠切换/会话切换时的清屏 + Static 重挂载。 */
  clearScreenRemount(): void
}

// 键盘路由的装配层：全局拦截（Ctrl+C / suppressEnter）→ 按 view.kind 分派给特征的 keys 处理器。
// 各特征的按键逻辑在 features/*/keys.ts（纯逻辑，测试注入 spy api）——本文件只做分派，不做判断。
export function useKeyRouting(deps: KeyRoutingDeps): { suppressEnter(): void } {
  const suppressEnterRef = useRef(false)
  // 吞掉紧随命令后的第一次回车：port 是同步通道，命令的响应可能立即设新 view，
  // 不吞的话同一个回车会被 useInput 在新 view 里再处理一次（误选中第一项）。
  const suppressEnter = useCallback(() => {
    suppressEnterRef.current = true
    queueMicrotask(() => { suppressEnterRef.current = false })
  }, [])

  useInput((inputChar, key) => {
    // Ctrl+C：全局拦截——优先级最高，覆盖所有 view 类型。
    if (key.ctrl && inputChar === 'c') {
      resetSigintTimer()
      const status = deps.statusRef.current
      const running = status !== 'idle' && status !== 'finished' && status !== 'cancelled' && status !== 'error'
      if (running) {
        deps.port.post({ type: 'cancel' })
      } else if (deps.viewRef.current.kind !== 'menu') {
        // 空闲且没在菜单里 → 弹退出确认（和 /quit 一致）
        suppressEnter()
        deps.setView({ kind: 'menu', title: '退出 DogEggAgent？', items: [
          { label: '确认退出', onSelect: () => { deps.port.post({ type: 'quit' }); deps.setView({ kind: 'none' }) } },
          { label: '取消', onSelect: () => deps.setView({ kind: 'none' }) },
        ], cursor: 0 })
      }
      return
    }
    if (key.return && suppressEnterRef.current) { suppressEnterRef.current = false; return }
    const v = deps.viewRef.current
    switch (v.kind) {
      case 'permission':
        return handlePermissionKeys(v, key, { setView: deps.setView, post: (m) => deps.port.post(m) })
      case 'menu':
        return handleMenuKeys(v, key, { setView: deps.setView })
      case 'prompt':
        return handlePromptKeys(v, key, { setView: deps.setView })
      case 'sessionPicker':
        return handleSessionPickerKeys(v, key, inputChar, { setView: deps.setView, post: (m) => deps.port.post(m), suppressEnter })
      case 'config':
        return handleConfigKeys(v, key, inputChar, { setView: deps.setView, getConfig: () => deps.configRef.current, treeCtx: deps.treeCtx })
      case 'info':
        return handleInfoKeys(v, key, { setView: deps.setView, setInfoScroll: deps.infoScroll })
      case 'none': {
        // 分派顺序即原优先级：联想 → 浏览 → 历史（历史仅在非浏览模式下生效）。
        if (handleSuggestionKeys(key, inputChar, { setInput: deps.setInput, getInput: () => deps.input, getSuggestCursor: deps.suggest.get, setSuggestCursor: deps.suggest.set })) return
        if (handlePathSuggestKeys(key, inputChar, { getInput: () => deps.input, getSuggestCursor: deps.suggest.get, setSuggestCursor: deps.suggest.set, applyCompletion: (entry) => deps.setInput(applyPathCompletion(deps.input, matchPathToken(deps.input, deps.cwd)!.replaceStart, entry)), cwd: deps.cwd, dismissed: deps.pathDismissed, dismiss: deps.dismissPathSuggest })) return
        if (handleBrowseKeys(key, { getBrowseIdx: deps.browse.get, setBrowseIdx: deps.browse.set, getBlocks: deps.browse.blocks, isExpanded: deps.browse.isExpanded, toggleExpanded: deps.browse.toggle, clearScreenRemount: deps.clearScreenRemount })) return
        if (deps.browse.get() === null) {
          handleHistoryKeys(key, { setInput: deps.setInput, items: deps.history.items, cursor: deps.history.cursor, setCursor: deps.history.setCursor })
        }
        return
      }
    }
  })
  return { suppressEnter }
}
