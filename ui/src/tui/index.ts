// tui 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { App, renderTui, type View } from './app'
export { ICON, COLOR, reducer, type Block, type ChatState } from './chat'
export { parseCommand, type CommandResult } from './input'
export { TopBar, MessageBlock, StatusBar, ListPicker } from './components'
export { renderMarkdown } from './markdown'
export { palette, type BlockColor } from './theme'
export { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from './overlays/config'
