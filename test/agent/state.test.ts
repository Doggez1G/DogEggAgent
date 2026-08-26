import { describe, it, expect } from 'vitest'
import { transition } from '../../src/agent/state'

describe('state machine', () => {
  it('submit reasoning → thinking', () => {
    expect(transition('idle', { kind: 'submit', reasoning: true })).toBe('thinking')
  })

  it('submit normal → responding', () => {
    expect(transition('idle', { kind: 'submit', reasoning: false })).toBe('responding')
  })

  it('response with tool_calls flows to permission then executing', () => {
    expect(transition('responding', { kind: 'tool_calls' })).toBe('tool_calling')
    expect(transition('tool_calling', { kind: 'tool_needs_permission' })).toBe('waiting_permission')
    expect(transition('waiting_permission', { kind: 'allow' })).toBe('executing')
  })

  it('cancel from any running state → cancelled', () => {
    expect(transition('executing', { kind: 'cancel' })).toBe('cancelled')
  })

  it('final answer → finished', () => {
    expect(transition('responding', { kind: 'final_answer' })).toBe('finished')
  })
})