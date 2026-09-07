export { ShellTool } from './tool'

// interpreter 的解析函数也导出（测试与潜在复用），但经 index 而非直接指向 interpreter.ts（模块边界）。
export { resolveShell, defaultShell, type ShellSpec } from './support/interpreter'
