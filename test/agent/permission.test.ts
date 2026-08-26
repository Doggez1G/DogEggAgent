import { describe, it, expect } from 'vitest'
import { PermissionManager } from '../../src/agent/permission'

const cfg = { allow: ['read_file'], reject: ['shell'], ask: ['write_file'] }

describe('PermissionManager', () => {
  it('classifies by bucket with safe default', () => {
    const pm = new PermissionManager(cfg)
    expect(pm.classify('read_file')).toBe('allow')
    expect(pm.classify('shell')).toBe('reject')
    expect(pm.classify('write_file')).toBe('ask')
    expect(pm.classify('edit_file')).toBe('ask')
  })

  it('allow_always promotes tool for the session', () => {
    const pm = new PermissionManager(cfg)
    pm.apply('write_file', 'allow_always')
    expect(pm.classify('write_file')).toBe('allow')
  })

  it('reject decision does not promote', () => {
    const pm = new PermissionManager(cfg)
    pm.apply('write_file', 'reject')
    expect(pm.classify('write_file')).toBe('ask')
  })
})