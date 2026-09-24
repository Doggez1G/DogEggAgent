import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { detectShells, resetDetectCache } from '../../src/tools/shell/support/detect'

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
