// shared 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// TUI 与 WebUI 共用的平台无关逻辑：block 模型、reducer、commands、
// 状态标签、权限标签、命令反馈映射。
// config 编辑器纯函数 (build/entries/navigation/label) 已移至 tui/config（仅 TUI 使用）。
export { type Block, type BlockKind, type ColorToken, type ToolStatus, type ToolBodyLine, isExpandable } from './block'
export { reducer, type ChatState, type Action } from './reducer'
export { formatToolArgs, formatToolResult, formatToolTitle, formatToolBody } from './tool-display'
export { parseCommand, matchCommands, COMMANDS, type CommandResult } from './commands'
export { STATUS_LABELS, isStateRunning, pendingToolLabel } from './status'
export { getToolPermission, effectivePerm, displayPerm, describeBucketTool } from './permission'
export { COMMAND_FEEDBACK_MAP, getCommandFeedback } from './command-feedback'
export { KNOWN_TOOLS } from './tools'
