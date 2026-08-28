import { describe, it, expect } from 'vitest'
import { spinnerFrame, getFrames, isAnimated } from '../../../src/tui/spinner'

describe('spinnerFrame', () => {
  it('thinking: 蛋静止 3 帧后露出孵化', () => {
    expect(spinnerFrame('thinking', 0)).toBe('🥚')
    expect(spinnerFrame('thinking', 1)).toBe('🥚')
    expect(spinnerFrame('thinking', 2)).toBe('🥚')
    expect(spinnerFrame('thinking', 3)).toBe('🐣')
    // 循环
    expect(spinnerFrame('thinking', 4)).toBe('🥚')
    expect(spinnerFrame('thinking', 7)).toBe('🐣')
  })

  it('executing: 爪左右移动', () => {
    expect(spinnerFrame('executing', 0)).toBe('🐾')
    expect(spinnerFrame('executing', 1)).toBe(' 🐾')
    expect(spinnerFrame('executing', 2)).toBe('  🐾')
    expect(spinnerFrame('executing', 3)).toBe(' 🐾')
    // 循环
    expect(spinnerFrame('executing', 4)).toBe('🐾')
  })

  it('tool_calling: 与 executing 相同帧序列', () => {
    expect(spinnerFrame('tool_calling', 0)).toBe('🐾')
    expect(spinnerFrame('tool_calling', 2)).toBe('  🐾')
  })

  it('responding: 爪+光标交替', () => {
    expect(spinnerFrame('responding', 0)).toBe('🐾 ▌')
    expect(spinnerFrame('responding', 1)).toBe('🐾  ')
    expect(spinnerFrame('responding', 2)).toBe('🐾 ▌')
  })

  it('compacting: 蛋抖动', () => {
    expect(spinnerFrame('compacting', 0)).toBe('🥚')
    expect(spinnerFrame('compacting', 1)).toBe('🥚')
  })

  it('非运行态返回静态图标', () => {
    expect(spinnerFrame('idle', 0)).toBe('🥚')
    expect(spinnerFrame('finished', 0)).toBe('🐥')
    expect(spinnerFrame('cancelled', 0)).toBe('🥚')
    expect(spinnerFrame('error', 0)).toBe('🐶 汪')
    expect(spinnerFrame('waiting_permission', 0)).toBe('⚠')
  })

  it('非运行态 frame 参数无效', () => {
    expect(spinnerFrame('idle', 999)).toBe('🥚')
  })
})

describe('isAnimated', () => {
  it('运行态需要动画', () => {
    expect(isAnimated('thinking')).toBe(true)
    expect(isAnimated('responding')).toBe(true)
    expect(isAnimated('executing')).toBe(true)
    expect(isAnimated('tool_calling')).toBe(true)
    expect(isAnimated('compacting')).toBe(true)
  })

  it('非运行态不需要动画', () => {
    expect(isAnimated('idle')).toBe(false)
    expect(isAnimated('finished')).toBe(false)
    expect(isAnimated('cancelled')).toBe(false)
    expect(isAnimated('error')).toBe(false)
    expect(isAnimated('waiting_permission')).toBe(false)
  })
})

describe('getFrames', () => {
  it('运行态返回帧序列', () => {
    expect(getFrames('thinking')?.length).toBe(4)
    expect(getFrames('executing')?.length).toBe(4)
    expect(getFrames('responding')?.length).toBe(2)
  })

  it('非运行态返回 null', () => {
    expect(getFrames('idle')).toBeNull()
    expect(getFrames('finished')).toBeNull()
  })
})
