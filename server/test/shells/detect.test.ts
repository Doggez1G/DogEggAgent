import { describe, it, expect } from 'vitest'
import { detectShells, ShellDetector, type ProbeFn } from '../../src/shells/detect'

// shells 探测测试：probe 全部注入假实现——不真拉起子进程（真探测受环境 shell 组合影响，
// 且最坏 3s 超时太慢），只验证探测核心的调度语义。默认探测实现（execFile + 3s timeout）
// 是薄封装，不做真进程测试。
describe('detectShells（探测核心，probe 注入）', () => {
  it('候选并行探测：全部候选同时在途（不再逐个串行阻塞事件循环）', async () => {
    let active = 0
    let peak = 0
    const probe: ProbeFn = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    }
    await detectShells(probe)
    // 6 个候选的第一轮探测全部同时发起——旧串行实现的 peak 只会是 1。
    expect(peak).toBe(6)
  })

  it('失败不拖垮其它：部分候选探测失败，其余照常返回', async () => {
    // pwsh / zsh 两轮全失败（假 probe 对所有参数都 reject），其余候选正常可用。
    const probe: ProbeFn = async (cmd) => {
      if (cmd === 'pwsh' || cmd === 'zsh') throw new Error('not found')
    }
    const found = await detectShells(probe)
    expect(found.map((f) => f.value)).toEqual(['powershell', 'cmd', 'bash', 'sh'])
  })

  it('两轮回退：--version 失败但 /c exit 0 成功的候选仍可用，且同一候选两轮串行', async () => {
    const rounds: string[] = []
    // 第一轮（--version）全部失败——模拟 Windows 上 cmd 不支持 --version 的形态。
    const probe: ProbeFn = async (cmd, args) => {
      rounds.push(`${cmd} ${args.join(' ')}`)
      if (args[0] !== '/c') throw new Error('unsupported')
    }
    const found = await detectShells(probe)
    expect(found).toHaveLength(6)
    // 每个候选自己的两轮保持串行：先 --version、后 /c exit 0（跨候选可交错并行）。
    for (const c of ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh']) {
      expect(rounds.filter((r) => r.startsWith(`${c} `))).toEqual([
        `${c} --version`,
        `${c} /c exit 0`,
      ])
    }
  })

  it('结果保持候选声明顺序（与探测完成时序无关）', async () => {
    // 越靠后的候选 resolve 越快——并行下乱序完成，输出仍按声明顺序。
    const delay: Record<string, number> = { sh: 1, zsh: 2, bash: 3, cmd: 4, pwsh: 5, powershell: 6 }
    const probe: ProbeFn = async (cmd) => {
      await new Promise((r) => setTimeout(r, delay[cmd] ?? 9))
    }
    const found = await detectShells(probe)
    expect(found.map((f) => f.value)).toEqual(['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh'])
    // 顺序之外，label 也原样透传（不因并行丢失）。
    expect(found[0]).toEqual({ value: 'powershell', label: 'PowerShell 5.1（Windows 内置，不支持 &&）' })
  })

  it('全部候选失败 → 空数组，不抛错', async () => {
    const found = await detectShells(async () => { throw new Error('nope') })
    expect(found).toEqual([])
  })
})

describe('ShellDetector（惰性缓存语义不变）', () => {
  it('detect 两次只探测一次（缓存命中返回同一结果）', async () => {
    let calls = 0
    const probe: ProbeFn = async () => { calls++ }
    const detector = new ShellDetector(probe)

    const first = await detector.detect()
    const second = await detector.detect()

    expect(calls).toBe(6) // 6 个候选各探测一轮，仅一次完整检测
    expect(second).toBe(first) // 同一数组引用——缓存
  })

  it('并行请求下 detect 也只触发一次探测（Promise 共享缓存）', async () => {
    let calls = 0
    const probe: ProbeFn = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 5))
    }
    const detector = new ShellDetector(probe)

    const [a, b] = await Promise.all([detector.detect(), detector.detect()])
    expect(calls).toBe(6)
    expect(b).toBe(a)
  })
})
