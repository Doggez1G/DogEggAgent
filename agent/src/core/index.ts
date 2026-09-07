// core 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { Agent, type AgentOptions } from './agent'
export { PendingPermissions } from './pending'
export { transition, type TransitionInput } from './state'
