import { describe, it, expect, vi } from 'vitest'
import { ThemeRegistry } from '../../src/tui/theme/registry'

describe('ThemeRegistry', () => {
  it('默认主题与取色', () => {
    const r = new ThemeRegistry()
    expect(r.name).toBe('mocha')
    expect(r.palette.accent).toBe('#89b4fa')
  })

  it('set 切换主题并通知订阅者', () => {
    const r = new ThemeRegistry()
    const cb = vi.fn()
    r.onChange(cb)
    r.set('gruvbox')
    expect(r.name).toBe('gruvbox')
    expect(r.palette.accent).toBe('#fe8019')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('未知主题与同名主题不触发通知', () => {
    const r = new ThemeRegistry()
    const cb = vi.fn()
    r.onChange(cb)
    r.set('not-a-theme')
    r.set('mocha')
    expect(cb).not.toHaveBeenCalled()
  })

  it('onChange 返回退订函数；list 列出全部主题', () => {
    const r = new ThemeRegistry()
    const off = r.onChange(() => {})
    off()
    r.set('dogegg')
    expect(r.palette.accent).toBe('#f5a97f') // 无通知也不影响取值
    expect(r.list().some((t) => t.name === 'dogegg')).toBe(true)
  })
})
