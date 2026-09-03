// config 编辑器逻辑从 tui/config re-export（仅 TUI 使用，WebUI 有自己的 settings 实现）。
export { buildEntries, parentPath, entryLabel, nan, type ConfigPath, type Entry, type TreeCtx } from '../../config'
