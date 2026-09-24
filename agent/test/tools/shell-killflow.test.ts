import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { ShellTool } from '../../src/tools/shell'
// setKillWatchdogForTest 是 tool.ts 的测试缝隙（对齐 resetDetectCache 先例），未上 index。
import { setKillWatchdogForTest } from '../../src/tools/shell/tool'
// killTree 同理未经 index 暴露；此处验证其 spawn 失败不崩进程，直连 support 文件。
import { killTree } from '../../src/tools/shell/support/kill-tree'

// 「杀不死且持有 stdio 的进程」真实平台造不出来（taskkill /T /F 必杀树）——mock spawn 是
// 复现「close 永不到达」的唯一确定性路径，顺带覆盖 kill-tree 的 error 监听立法。
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const isWin = process.platform === 'win32'

// 假子进程：close 永不到达，stdout/stderr 可发 data、可销毁，kill 可被调（POSIX 回退路径）。
type FakeStream = EventEmitter & { destroy: ReturnType<typeof vi.fn> }
type FakeChild = EventEmitter & { pid: number; stdout: FakeStream; stderr: FakeStream; kill: ReturnType<typeof vi.fn> }

function withDestroy(e: EventEmitter): FakeStream {
  const s = e as FakeStream
  s.destroy = vi.fn()
  return s
}

function fakeChild(pid = 1234): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = withDestroy(new EventEmitter())
  child.stderr = withDestroy(new EventEmitter())
  child.kill = vi.fn()
  return child
}

describe('shell 杀进程兜底（mock 子进程）', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
    setKillWatchdogForTest(50) // 缩短看门狗宽限，用例毫秒级完成
  })
  afterEach(() => setKillWatchdogForTest(5_000)) // 还原真实宽限，防泄漏到其他文件

  it('kill 后 close 永不到达：二级看门狗按已采集输出强制收场并销毁流', async () => {
    const main = fakeChild()
    vi.mocked(spawn)
      .mockImplementationOnce(() => main as never)
      .mockImplementation(() => fakeChild(9999) as never) // 后续 spawn（win32 的 taskkill）
    const p = new ShellTool().execute(
      { command: 'hang-forever' },
      { cwd: '.', signal: new AbortController().signal, shellTimeoutMs: 30 },
    )
    main.stdout.emit('data', Buffer.from('partial out')) // data 监听在 execute 内同步挂上
    // 30ms 超时 → kill；50ms 宽限内 close 不来 → 看门狗强制收场
    const r = (await p) as { content: string }
    expect(r.content).toContain('partial out')
    expect(r.content).toContain('[进程未正常退出，已按已有输出返回]')
    expect(main.stdout.destroy).toHaveBeenCalled()
    expect(main.stderr.destroy).toHaveBeenCalled()
  })

  it('正常路径回归：close 先到 → 看门狗被清理，回执仍是 exit=code + 输出', async () => {
    const main = fakeChild()
    vi.mocked(spawn)
      .mockImplementationOnce(() => main as never)
      .mockImplementation(() => fakeChild(9999) as never)
    const p = new ShellTool().execute(
      { command: 'echo hi' },
      { cwd: '.', signal: new AbortController().signal, shellTimeoutMs: 10_000 },
    )
    main.stdout.emit('data', Buffer.from('hi\n'))
    main.emit('close', 0)
    const r = (await p) as { content: string }
    expect(r).toEqual({ content: 'exit=0\nhi\n' })
    expect(main.stdout.destroy).not.toHaveBeenCalled() // 正常收场不销毁流
  })

  it('error 路径（spawn 失败）同样幂等收场：定时器与 abort 监听被清', async () => {
    const main = fakeChild()
    vi.mocked(spawn).mockImplementationOnce(() => main as never)
    const ac = new AbortController()
    const p = new ShellTool().execute(
      { command: 'nope' },
      { cwd: '.', signal: ac.signal, shellTimeoutMs: 10_000 },
    )
    main.emit('error', new Error('spawn ENOENT'))
    const r = await p
    expect(r).toEqual({ error: 'Error: spawn ENOENT' })
    // 收场后 abort 不再引发任何后续动作（监听已摘）——不抛不挂即通过
    expect(() => ac.abort()).not.toThrow()
  })
})

describe('killTree（win32 taskkill 路径）', () => {
  it.skipIf(!isWin)('spawn 的 error 事件有监听：taskkill 不可达不崩 agent 进程', () => {
    const child = fakeChild()
    const killer = fakeChild(9999)
    vi.mocked(spawn).mockImplementation(() => killer as never)
    expect(() => killTree(child as never)).not.toThrow()
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '1234', '/T', '/F'])
    // 无监听器时 emit error 会以未捕获异常炸掉进程——有监听器则静默吞掉
    expect(() => killer.emit('error', new Error('spawn taskkill ENOENT'))).not.toThrow()
  })
})
