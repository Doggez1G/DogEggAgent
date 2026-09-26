// config 域出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
// schema 本体 + isConfigured 在 bridge 契约，agent 不重写。
export { ConfigStore, ConfigParseError } from './store'
export { resolveCurrent } from './resolve'
export { ConfigController } from './controller'
export {
  ConfigEditor,
  parseConfigSet,
  parseConfigAdd,
  type ConfigSetOp,
  type ConfigAddOp,
  applySet,
  applyAdd,
  applyRemove,
  validateConfig,
  findDuplicateName,
} from './editor'
