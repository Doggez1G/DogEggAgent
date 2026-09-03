// chat 模块：block/reducer/commands 从 shared 复用（语义化 Block 模型），viewport/browse 是 TUI 专属。
export { type Block, type BlockKind, type ColorToken, isExpandable } from '../../shared'
export { reducer, type ChatState, type Action } from '../../shared'
export { estimateBlockLines, buildDisplayBlocks, sliceViewport, type DisplayBlock } from './viewport'
export { expandableIndices, moveBrowse, toggleExpanded } from './browse'
