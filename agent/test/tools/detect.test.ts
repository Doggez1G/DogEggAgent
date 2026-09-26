import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { detectShells, resetDetectCache, resolveShellPath } from '../../src/tools/shell/support/detect'

// detectShells 的 PATH 扫描立法测试。
// 回归点：EXE_NAME 自带扩展名（powershell.exe 等），PATHEXT 只是补充——旧实现只查
// exe+ext 拼接（powershell.exe.EXE，永不存在），导致 powershell/pwsh/bash 恒扫描不到。
// 用「只含受控临时目录的 PATH」跑真实平台 + 真实 PATHEXT：断言到的命中只可能来自
// 临时空文件，不受本机真实安装的 shell 影响。
// 直连 support/detect.ts：resetDetectCache 是测试专用缝隙，未上 index（对外脸面保持最小）。

let dir: string | null = null
let savedPath: string | undefined

afterEach(() => {
  // PATH 与扫描缓存必须复原：detectShells 结果是进程级缓存，污染会泄漏到其他用例。
  if (savedPath !== undefined) {
    process.env.PATH = savedPath
    savedPath = undefined
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
  resetDetectCache()
})

// 准备一个只含指定假 exe 的 PATH 目录，并重置扫描缓存。返回前进程已处于受控环境。
function stageFakePath(files: string[]): string {
  dir = mkdtempSync(join(tmpdir(), 'dogegg-detect-'))
  for (const f of files) writeFileSync(join(dir, f), '') // 空文件即可——扫描只查存在性
  savedPath = process.env.PATH
  process.env.PATH = dir
  resetDetectCache()
  return dir
}

describe('detectShells（PATH 扫描）', () => {
  it('裸名命中（EXE_NAME 自带扩展名）：powershell.exe 与 bash.exe 均可被扫到', () => {
    stageFakePath(['powershell.exe', 'bash.exe'])
    const shells = detectShells(process.platform) // 真实平台 + 真实 PATHEXT
    expect(shells).toContain('bash')
    if (process.platform === 'win32') {
      // Windows 分支才扫描 powershell；Unix 分支只有 bash/sh 两项。
      expect(shells).toContain('powershell')
      expect(shells).toContain('cmd') // Windows 基线解释器，恒在
    }
  })

  it('PATH 无命中时仅剩平台基线（win32: cmd / unix: sh），不误报', () => {
    stageFakePath([]) // 空目录：受控 PATH 下扫不到任何可选 shell
    const shells = detectShells(process.platform)
    if (process.platform === 'win32') expect(shells).toEqual(['cmd'])
    else expect(shells).toEqual(['sh'])
  })
})

describe('resolveShellPath（bash 身份消歧，P1-5）', () => {
  // 造真实 System32 需要管理员权限——判定只看「命中目录的末段名为 System32」（大小写不敏感），
  // 同名临时目录足以触发同一分支，且不会污染真 System32。
  it.skipIf(process.platform !== 'win32')('win32：System32 目录下的 bash.exe 判为 WSL 启动器——剔除出检测且路径解析为 null', () => {
    dir = mkdtempSync(join(tmpdir(), 'dogegg-detect-'))
    const fakeSystem32 = join(dir, 'System32')
    mkdirSync(fakeSystem32)
    writeFileSync(join(fakeSystem32, 'bash.exe'), '')
    savedPath = process.env.PATH
    process.env.PATH = fakeSystem32
    resetDetectCache()
    // 检测与路径解析必须同一口径：bash 被 WSL 消歧剔除，spawn 侧也拿不到可执行路径。
    expect(detectShells('win32')).not.toContain('bash')
    expect(resolveShellPath('bash', 'win32')).toBeNull()
  })

  it('bash.exe 命中普通目录：进检测结果且 resolveShellPath 返回命中文件的绝对路径', () => {
    stageFakePath(['bash.exe'])
    expect(detectShells(process.platform)).toContain('bash')
    const p = resolveShellPath('bash')
    expect(p).not.toBeNull()
    expect(isAbsolute(p!)).toBe(true) // 绝对路径 spawn 是绕过 CreateProcess 搜索序的前提
    expect(p!.toLowerCase().endsWith('bash.exe')).toBe(true) // 指向被扫到的同一个文件
  })

  it('win32 基线 cmd 不走 PATH 扫描：resolveShellPath 给出 System32 下的绝对路径', () => {
    stageFakePath([]) // PATH 无 cmd.exe——cmd 是基线解释器（System32 恒在），不依赖 PATH
    if (process.platform !== 'win32') return // cmd 路径解析仅 win32 有意义
    const p = resolveShellPath('cmd', 'win32')
    expect(p).not.toBeNull()
    expect(p!.toLowerCase()).toContain('system32')
    expect(p!.toLowerCase().endsWith('cmd.exe')).toBe(true)
  })
})
