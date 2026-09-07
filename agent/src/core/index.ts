// core 包出口：纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { Agent, type AgentOptions } from './agent'
export { PendingPermissions } from './pending'
export { transition, StateMachine, type TransitionInput } from './state'
export { BusyGate } from './busy-gate'
export { Conversation } from './conversation'
export { TurnRunner, type TurnParams } from './turn-runner'
export { SessionManager } from './session-manager'
export { ConfigController } from './config-controller'
