import { describe, it, expect } from 'vitest'
import { resolveShell, defaultShell } from '../../src/common/utils/shell'

describe('resolveShell', () => {
  it('defaults to cmd on win32 and bash otherwise', () => {
    expect(defaultShell('win32')).toEqual({ program: 'cmd', flag: '/c' })
    expect(defaultShell('linux')).toEqual({ program: 'bash', flag: '-c' })
  })

  it('maps known interpreters to their standard flag', () => {
    expect(resolveShell('cmd', 'win32')).toEqual({ program: 'cmd', flag: '/c' })
    expect(resolveShell('powershell', 'win32')).toEqual({ program: 'powershell', flag: '-Command' })
    expect(resolveShell('pwsh', 'win32')).toEqual({ program: 'powershell', flag: '-Command' })
    expect(resolveShell('bash', 'win32')).toEqual({ program: 'bash', flag: '-c' })
    expect(resolveShell('sh', 'win32')).toEqual({ program: 'sh', flag: '-c' })
  })

  it('falls back to program + -c for unknown values', () => {
    expect(resolveShell('zsh', 'linux')).toEqual({ program: 'zsh', flag: '-c' })
    expect(resolveShell(undefined, 'linux')).toEqual({ program: 'bash', flag: '-c' })
  })
})