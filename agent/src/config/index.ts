// config 域出口：纯 re-export。schema 本体 + isConfigured 在 bridge 契约（②），agent 不重写。
export { findConfig, configTargetPath, loadConfig, saveConfig } from './loader'
export { resolveCurrent } from './resolve'
export { ConfigEditor } from './editor'
export { parseConfigSet, parseConfigAdd, type ConfigSetOp, type ConfigAddOp } from './editor'
export { applySet, applyAdd, applyRemove } from './editor'
export { validateConfig, findDuplicateName } from './editor'
