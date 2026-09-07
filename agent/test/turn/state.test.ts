import { describe, it, expect } from 'vitest'
import { transition } from '../../src/turn'

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

  it('reject/result_back re-request honoring reasoning', () => {
    expect(transition('waiting_permission', { kind: 'reject', reasoning: true })).toBe('thinking')
    expect(transition('waiting_permission', { kind: 'reject', reasoning: false })).toBe('responding')
    expect(transition('executing', { kind: 'result_back', reasoning: true })).toBe('thinking')
    expect(transition('executing', { kind: 'result_back', reasoning: false })).toBe('responding')
  })

  it('tool_done returns to tool_calling between tools', () => {
    expect(transition('executing', { kind: 'tool_done' })).toBe('tool_calling')
    expect(transition('waiting_permission', { kind: 'tool_done' })).toBe('tool_calling')
  })
})