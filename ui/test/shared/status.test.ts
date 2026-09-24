import { describe, it, expect } from 'vitest'
import { STATUS_LABELS, isStateRunning, pendingToolLabel } from '../../src/shared/status'
import type { State } from '@dogegg/bridge'

// 状态标签映射单测——十态全查。
// 背景（2026-09-24 运行中状态显示正确性）：executing/tool_calling/waiting_permission 此前
// 文案歧义（工具执行期间被误读为 thinking），立法后每个状态的文案必须自解释，
// 且 thinking/executing 等关键边界必须锚定，防止回归漂移。

// 后端状态机的全部十态（bridge/contract/shared.ts State）——逐个核对标签，
// 防止契约加态/减态时标签映射静默漏项（Record<string,string> 不受类型系统保护）。
const ALL_STATES: State[] = [
  'idle', 'thinking', 'responding', 'tool_calling', 'waiting_permission',
  'executing', 'finished', 'cancelled', 'error', 'compacting',
]

describe('STATUS_LABELS', () => {
  it('十态全覆盖，标签非空', () => {
    for (const s of ALL_STATES) {
      const label = STATUS_LABELS[s]
      expect(label, `状态 ${s} 缺少标签`).toBeTruthy()
    }
    expect(Object.keys(STATUS_LABELS)).toHaveLength(10)
  })

  it('关键边界：executing 是「正在执行工具」而非思考类文案', () => {
    // 用户实测教训：工具执行中被显示成 thinking，分不清真思考还是工具调用。
    expect(STATUS_LABELS.executing).toBe('正在执行工具')
    expect(STATUS_LABELS.executing).not.toContain('思考')
  })

  it('关键边界：tool_calling 表示「正在生成工具调用」（与 executing 区分阶段）', () => {
    expect(STATUS_LABELS.tool_calling).toBe('正在生成工具调用')
  })

  it('关键边界：waiting_permission 是「等待审批」', () => {
    expect(STATUS_LABELS.waiting_permission).toBe('等待审批')
  })

  it('终态与非运行态文案：idle/finished/cancelled/error/compacting', () => {
    expect(STATUS_LABELS.idle).toBe('就绪')
    expect(STATUS_LABELS.thinking).toBe('思考中')
    expect(STATUS_LABELS.responding).toBe('回复中')
    expect(STATUS_LABELS.finished).toBe('已完成')
    expect(STATUS_LABELS.cancelled).toBe('已取消')
    expect(STATUS_LABELS.error).toBe('出错')
    expect(STATUS_LABELS.compacting).toBe('压缩上下文')
  })

  it('未知状态无标签（消费方自行回退）', () => {
    expect(STATUS_LABELS['unknown_state']).toBeUndefined()
  })
})

describe('isStateRunning', () => {
  it('运行中五态（thinking/responding/tool_calling/waiting_permission/executing/compacting）为 true', () => {
    expect(isStateRunning('thinking')).toBe(true)
    expect(isStateRunning('responding')).toBe(true)
    expect(isStateRunning('tool_calling')).toBe(true)
    expect(isStateRunning('waiting_permission')).toBe(true)
    expect(isStateRunning('executing')).toBe(true)
    expect(isStateRunning('compacting')).toBe(true)
  })
  it('终态（idle/finished/cancelled/error）为 false', () => {
    expect(isStateRunning('idle')).toBe(false)
    expect(isStateRunning('finished')).toBe(false)
    expect(isStateRunning('cancelled')).toBe(false)
    expect(isStateRunning('error')).toBe(false)
  })
})

describe('pendingToolLabel', () => {
  it('有工具名：显示具体工具', () => {
    expect(pendingToolLabel('edit_file')).toBe('正在调用 edit_file…')
  })
  it('工具名缺失：退化为泛化文案', () => {
    expect(pendingToolLabel('')).toBe('正在调用工具…')
  })
})
