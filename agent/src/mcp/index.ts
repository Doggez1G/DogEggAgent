// mcp 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { McpManager, type McpServerStatusView } from './manager'
export { readProjectMcp, writeProjectMcp, mergeMcpServers, type McpMergedEntry } from './project'
