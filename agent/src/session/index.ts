// session 域出口：工作集 + 持久化 + 生命周期。纯 re-export，不含实现逻辑（见 §1 约束 3）。
export { Conversation } from './conversation'
export { SessionStore, defaultSessionsDir, type SessionSnapshot, type SessionSummary } from './store'
export { SessionManager } from './manager'
