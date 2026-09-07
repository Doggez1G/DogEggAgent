// 语言级支撑：取消错误 + 短 id。刻意的小文件——无归属域的语言级工具（粒度规则的立法例外）。
import { randomUUID } from 'node:crypto'

// 跨域共享的错误类型。
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

// 短 id，用于 session / 工具调用 / 审批请求的标识。取 UUID 前 8 位足够区分。
export function newId(): string {
  return randomUUID().slice(0, 8)
}
