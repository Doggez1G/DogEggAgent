import type { ConfigPath } from './navigation'

// 每个字段可能的呈现/交互形态。
export type Entry =
  | { label: string; kind: 'scalar'; value: string; save: (v: string) => void; del?: () => void } // 回车 → 输入（带当前值）；可带 del（按 d 删该条）
  | { label: string; kind: 'prompt'; title: string; save: (v: string) => void } // 回车 → 输入（新增）
  | { label: string; kind: 'bool'; value: boolean; save: (v: boolean) => void } // ←→ 切换 + 回车确认
  | { label: string; kind: 'goto'; value: string; subPath: ConfigPath; del?: () => void } // 回车钻入；数组项可带 del（按 d 删）
  | {
      label: string
      kind: 'action'
      value: string
      run: () => void
      del?: () => void
      /** 执行后的落点（选择即钻入）——selectTool 选中工具后直接进入该键的细化层，免去 esc 退回再钻入的往返。 */
      afterRunPath?: ConfigPath
    }

// 配置树的三类变更入口，统一翻译成 config_set/add/remove 消息。
export interface TreeCtx {
  set: (path: string, value: unknown) => void
  add: (path: string, value: unknown) => void
  remove: (path: string, index: number, providerIndex?: number) => void
  /** 打开 skills / mcp 管理面板（/skills、/mcp 同款）——/config 树的统一入口。 */
  openSkills?: () => void
  openMcp?: () => void
}
