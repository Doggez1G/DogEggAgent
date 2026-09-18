import { describe, it, expect } from 'vitest'
import { resolveShell, defaultShell } from '../../src/tools/shell'
import type { ShellKind } from '../../src/tools/shell'
import { shellGuidance } from '../../src/tools/shell'

// shell 解释器解析测试：kind 标注、本机扫描过滤（配置未扫描到 → 回退平台默认）、
// powershell 5.1 与 pwsh 7 的区分、未知解释器立法、模型可见的语法引导段。

const ALL: ShellKind[] = ['cmd', 'powershell', 'pwsh', 'bash', 'sh']
const WIN_ONLY_CMD: ShellKind[] = ['cmd']

describe('resolveShell', () => {
  it('defaults to cmd on win32 and bash otherwise', () => {
    expect(defaultShell('win32')).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
    expect(defaultShell('linux')).toEqual({ program: 'bash', flag: '-c', kind: 'bash' })
  })

  it('maps known interpreters to their standard flag + kind（注入本机扫描结果）', () => {
    expect(resolveShell('cmd', 'win32', ALL)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
    expect(resolveShell('powershell', 'win32', ALL)).toEqual({ program: 'powershell', flag: '-Command', kind: 'powershell' })
    // pwsh（7+）与 powershell（5.1）是两个 kind——不再混用
    expect(resolveShell('pwsh', 'win32', ALL)).toEqual({ program: 'pwsh', flag: '-Command', kind: 'pwsh' })
    expect(resolveShell('bash', 'win32', ALL)).toEqual({ program: 'bash', flag: '-c', kind: 'bash' })
    expect(resolveShell('sh', 'win32', ALL)).toEqual({ program: 'sh', flag: '-c', kind: 'sh' })
  })

  it('配置的 shell 不在本机扫描结果内 → 回退平台默认（立法：扫描结果约束配置生效）', () => {
    // 本机只扫到 cmd：配置 pwsh/powershell/bash 都回退 cmd
    expect(resolveShell('pwsh', 'win32', WIN_ONLY_CMD)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
    expect(resolveShell('powershell', 'win32', WIN_ONLY_CMD)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
    expect(resolveShell('bash', 'win32', WIN_ONLY_CMD)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
  })

  it('未知解释器（zsh 等）→ 回退平台默认（不猜测语义）', () => {
    expect(resolveShell('zsh', 'win32', ALL)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
    expect(resolveShell(undefined, 'win32', ALL)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
  })

  it('含非 ASCII 的非法值 → 回退平台默认', () => {
    expect(resolveShell('（默认按平台）', 'win32', ALL)).toEqual({ program: 'cmd', flag: '/c', kind: 'cmd' })
  })
})

describe('shellGuidance（模型可见的语法引导）', () => {
  it('cmd：提示无 Unix 命令 + %VAR% 变量', () => {
    const g = shellGuidance({ program: 'cmd', flag: '/c', kind: 'cmd' }, 'win32')
    expect(g).toContain('## Shell 环境')
    expect(g).toContain('cmd.exe')
    expect(g).toContain('%VAR%')
    expect(g).not.toContain('&& 与 ||') // cmd 段不含 PS 专属警示
  })

  it('powershell 5.1：明确提示不支持 && 与 ||', () => {
    const g = shellGuidance({ program: 'powershell', flag: '-Command', kind: 'powershell' }, 'win32')
    expect(g).toContain('PowerShell 5.1')
    expect(g).toContain('不支持 && 与 ||')
  })

  it('pwsh 7：说明支持 && 与 ||', () => {
    const g = shellGuidance({ program: 'pwsh', flag: '-Command', kind: 'pwsh' }, 'win32')
    expect(g).toContain('PowerShell 7')
    expect(g).toContain('支持 && 与 ||')
  })
})
