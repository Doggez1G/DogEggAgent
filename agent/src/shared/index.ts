// shared：跨域支撑（gate 是 agent 级并发状态，turn 与 session 都要读）。
// 纯 re-export，不含实现逻辑。support.ts 为刻意的小文件（语言级工具，粒度规则注释立法例外）。
export { Logger } from './logger'
export { BusyGate } from './gate'
export { CancelledError, newId } from './support'
export { resolveTargetPath } from './target-path'
export { atomicWriteFileSync, atomicWriteFile } from './atomic'
