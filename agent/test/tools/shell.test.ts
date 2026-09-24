import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { resolveShell, defaultShell, ShellTool } from '../../src/tools/shell'
import type { ShellKind } from '../../src/tools/shell'
import { shellGuidance } from '../../src/tools/shell'
import type { ToolContext } from '../../src/tools'

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

// 以下为真实子进程用例：命令用 node 运行临时 .js 文件（vitest 本身跑在 node 上，PATH 恒有
// node）。刻意走「脚本文件」而非 node -e "..."——cmd 的引号拼接会弄花内嵌双引号脚本，
// 且无引号命令跨 cmd/bash 写法一致。
describe('shell tool（真实子进程）', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'dogegg-shell-'))
  writeFileSync(join(workdir, 'gen-big.js'), "process.stdout.write('a'.repeat(2 * 1024 * 1024))")
  writeFileSync(join(workdir, 'gen-cjk.js'), "process.stdout.write('中'.repeat(300000))")
  writeFileSync(join(workdir, 'sleep.js'), 'setTimeout(() => {}, 10000)')
  afterAll(() => rmSync(workdir, { recursive: true, force: true }))
  const tool = new ShellTool()
  const ctx = (signal: AbortSignal, shellTimeoutMs?: number): ToolContext => ({
    cwd: workdir,
    signal,
    shellTimeoutMs,
  })

  it('输出超采集上限：停止累积且回执注明丢弃字节数', { timeout: 20_000 }, async () => {
    // 2MB 单字节输出 > 1MB 采集上限（SHELL_OUTPUT_CAP）——失控命令不能把 agent 拖向 OOM。
    const r = await tool.execute({ command: 'node gen-big.js' }, ctx(new AbortController().signal)) as { content: string }
    expect(r.content).toContain('[输出超过采集上限，已丢弃')
    // 采集体封顶在 1MB：回执整体必然远小于 2MB 原始输出
    expect(r.content.length).toBeLessThan(1024 * 1024 + 200)
  })

  it('多字节字符跨 chunk 不再截成乱码（Buffer 级拼接 + 统一解码）', { timeout: 20_000 }, async () => {
    // 900KB（< 1MB cap）的多字节输出：旧实现逐 chunk toString，chunk 边界切断三字节
    // 字符会产出 U+FFFD；新实现 Buffer.concat 后一次解码，内容必须逐字无损。
    const r = await tool.execute({ command: 'node gen-cjk.js' }, ctx(new AbortController().signal)) as { content: string }
    expect(r.content.startsWith('exit=0\n')).toBe(true)
    expect(r.content).not.toContain('\uFFFD')
    expect(r.content).not.toContain('已丢弃') // 未超上限：无丢弃说明
  })

  it('abort 中止长驻命令：杀树后按已有输出收场（close 先到，看门狗不触发）', { timeout: 15_000 }, async () => {
    const ac = new AbortController()
    const p = tool.execute({ command: 'node sleep.js' }, ctx(ac.signal, 30_000)) as Promise<{ content: string }>
    setTimeout(() => ac.abort(), 400) // 命令起来后再取消——走 abort → killTree → close 路径
    const r = await p
    // 10s 长驻进程在 400ms 即被杀：exit code 必非 0（若是 0 说明命令提前自行退出，用例失真）
    expect(r.content.startsWith('exit=0')).toBe(false)
    expect(r.content).not.toContain('进程未正常退出') // close 先到：看门狗被清理，不兜底
  })
})
