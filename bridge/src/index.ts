// bridge 包唯一对外脸面：纯 re-export，不含任何实现逻辑（见 §1 约束 3）。
export * from './contract/shared'
export * from './contract/config'
export * from './contract/agent-to-ui'
export * from './contract/ui-to-agent'
export { uiToAgentMessageSchema } from './contract/ui-to-agent-schema'
export * from './channel/port'
export * from './channel/in-memory'
