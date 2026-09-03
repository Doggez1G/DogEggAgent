// config 编辑器逻辑已移至 shared（平台无关纯函数），TUI 从此处 re-export。
export { buildEntries } from '../../../shared/config'
export { parentPath, type ConfigPath } from '../../../shared/config'
export { entryLabel, nan } from '../../../shared/config'
export { type Entry, type TreeCtx } from '../../../shared/config'
