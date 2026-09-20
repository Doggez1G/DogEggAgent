import type { Key } from 'ink'
import type { View } from '../../view-state'

export interface FormKeysApi {
  setView(view: View): void
}

// 表单按键：↑↓ 在字段与保存行之间循环（游标 = fields.length 即保存行）；
// Enter——文本字段弹 prompt（prefill 当前值，esc 回表单）、选项字段循环切换、保存行提交；
// s 保存；esc 返回 returnView（不保存）。
export function handleFormKeys(v: Extract<View, { kind: 'form' }>, key: Key, inputChar: string, api: FormKeysApi): void {
  const max = v.fields.length // 保存行游标
  if (key.upArrow) {
    api.setView({ ...v, cursor: (v.cursor + max) % (max + 1) })
  } else if (key.downArrow) {
    api.setView({ ...v, cursor: (v.cursor + 1) % (max + 1) })
  } else if (key.escape) {
    api.setView(v.returnView)
  } else if (inputIsSave(v, key, inputChar)) {
    submit(v, api)
  } else if (key.return) {
    const field = v.fields[v.cursor]
    if (!field) return submit(v, api) // 保存行
    if (field.readonly) return
    if (field.options) {
      // 选项字段：Enter 循环切到下一个选项。
      const idx = field.options.findIndex((o) => o.value === field.value)
      const next = field.options[(idx + 1) % field.options.length] ?? field.options[0]!
      api.setView({ ...v, fields: v.fields.map((f, j) => (j === v.cursor ? { ...f, value: next.value } : f)) })
    } else {
      // 文本字段：prompt 编辑（esc 经 returnView 回到当前表单——提交/取消都不丢已改字段）。
      api.setView({
        kind: 'prompt',
        title: field.label,
        value: field.value,
        returnView: v,
        onSubmit: (val) => api.setView({ ...v, fields: v.fields.map((f, j) => (j === v.cursor ? { ...f, value: val } : f)) }),
      })
    }
  }
}

function inputIsSave(v: Extract<View, { kind: 'form' }>, key: Key, inputChar: string): boolean {
  return (key.return && v.cursor === v.fields.length) || inputChar === 's'
}

function submit(v: Extract<View, { kind: 'form' }>, api: FormKeysApi): void {
  v.onSubmit(v.fields.map((f) => f.value))
}
