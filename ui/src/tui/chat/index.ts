// chat 模块：reducer/Block 模型从 shared 复用（语义化 Block），TUI 无专属逻辑
// （历史消息经 Static 打印进终端缓冲区，无需视口裁切/滚动计算）。
export { type Block, type BlockKind, type ColorToken, isExpandable } from '../../shared'
export { reducer, type ChatState, type Action } from '../../shared'
