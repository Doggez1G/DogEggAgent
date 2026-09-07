// tui 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// block/reducer/commands 从 shared 复用；viewport/browse 是 TUI 专属。
export { App, renderTui } from './app'
export { type View } from './view-state'
export { type Block, type BlockKind, type ColorToken, isExpandable, reducer, type ChatState } from '../shared'
export { parseCommand, type CommandResult } from '../shared'
export { TopBar, MessageBlock, StatusBar, ListPicker } from './components'
export { renderMarkdown } from './markdown'
export { palette, type BlockColor, KIND_ICON, TOKEN_COLOR, KIND_ROLE } from './theme'
export { buildEntries, parentPath, entryLabel, type ConfigPath, type Entry, type TreeCtx } from './features/config'
