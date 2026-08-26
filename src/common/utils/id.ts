import { randomUUID } from 'node:crypto'

// 短 id，用于 session / 工具调用 / 审批请求的标识。取 UUID 前 8 位足够区分。
export function newId(): string {
  return randomUUID().slice(0, 8)
}