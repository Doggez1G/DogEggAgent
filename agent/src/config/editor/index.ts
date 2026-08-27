// editor 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { ConfigEditor } from './editor'
export { parseConfigSet, parseConfigAdd, type ConfigSetOp, type ConfigAddOp } from './paths'
export { applySet, applyAdd, applyRemove } from './mutate'
export { validateConfig, findDuplicateName } from './validate'
