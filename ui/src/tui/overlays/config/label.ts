import type { Entry } from './entries'

// 条目的展示文本；bool 条目支持用 previewBool 体现「左右切换未确认」的预览值。
export function entryLabel(e: Entry, previewBool?: boolean): string {
  switch (e.kind) {
    case 'scalar': return `${e.label}  ${e.value || '（空）'}`
    case 'prompt': case 'action': return e.label
    case 'bool': return `${e.label}  ${previewBool ?? e.value}`
    case 'goto': return `${e.label}  ${e.value}`
  }
}

// 字符串转数字，非数字返回 0（配置编辑器里 contextWindow 等数值字段的容错）。
export const nan = (s: string): number => (Number.isFinite(Number(s)) ? Number(s) : 0)
