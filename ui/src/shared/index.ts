// shared 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// TUI 与 WebUI 共用的平台无关逻辑：block 模型、reducer、commands、config 编辑器纯函数、
// 状态标签、权限标签、命令反馈映射。
export { type Block, type BlockKind, type ColorToken, isExpandable } from './block'
export { reducer, type ChatState, type Action } from './reducer'
export { parseCommand, matchCommands, COMMANDS, type CommandResult } from './commands'
export { buildEntries, parentPath, entryLabel, nan, type ConfigPath, type Entry, type TreeCtx } from './config'
export { STATUS_LABELS, isStateRunning } from './status'
export { getToolPermission } from './permission'
export { COMMAND_FEEDBACK_MAP, getCommandFeedback } from './command-feedback'
