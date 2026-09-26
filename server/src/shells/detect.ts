import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// 系统 shell 候选——按常见顺序检测。
const CANDIDATES = [
  // powershell.exe 只对应 Windows PowerShell 5.1（6+ 已改名 pwsh.exe）——标签直接标注版本
  { cmd: 'powershell', value: 'powershell', label: 'PowerShell 5.1（Windows 内置，不支持 &&）' },
  { cmd: 'pwsh', value: 'pwsh', label: 'PowerShell 7+（pwsh）' },
  { cmd: 'cmd', value: 'cmd', label: 'Command Prompt (cmd)' },
  { cmd: 'bash', value: 'bash', label: 'Bash' },
  { cmd: 'zsh', value: 'zsh', label: 'Zsh' },
  { cmd: 'sh', value: 'sh', label: 'sh' },
]

// 探测函数注入点：给定命令与参数，「可执行」则 resolve、「不可用」则 reject。
// 生产实现是 promisify 后的 execFile（无 shell，避免 shell 注入）；测试注入假实现，
// 避免真拉起子进程，并可精确控制成功/失败与时序。
export type ProbeFn = (cmd: string, args: string[]) => Promise<unknown>

// 默认探测实现：execFile（无 shell）避免 shell 注入；timeout 3s 与旧 execFileSync 实现
// 一致。注：execFile 只支持 stdio 管道（无 'stdio' 选项，默认即 pipe，等价于旧实现的
// `stdio: 'pipe'`，输出不会混入进程 stdout/stderr）。
const execFileAsync = promisify(execFile)
const defaultProbe: ProbeFn = (cmd, args) =>
  execFileAsync(cmd, args, { timeout: 3000 })

// 单个候选的探测：先 `--version`，失败再回退无 shell 探测 `/c exit 0`
//（cmd 在 Windows 不支持 --version）——同一候选的两轮保持【串行】。
// 两轮都失败视为该 shell 不可用；失败只影响本候选，绝不向外抛。
async function probeCandidate(c: { cmd: string }, probe: ProbeFn): Promise<boolean> {
  try {
    await probe(c.cmd, ['--version'])
    return true
  } catch {
    try {
      await probe(c.cmd, ['/c', 'exit 0'])
      return true
    } catch {
      // shell not available — skip
      return false
    }
  }
}

// 探测核心：全部候选【并行】探测。
// P2-20：旧实现 execFileSync 逐个同步探测（6 候选 × 2 轮 × 3s 超时，最坏 ~36s 全同步），
// 且惰性缓存——首次 GET /api/shells 时整个 server 事件循环被冻结。改为 execFile 异步
// 子进程 + 各候选并行：总耗时收敛到单候选最坏耗时（两轮 ≈ 6s），期间事件循环照常服务
// 其它请求。失败的候选只影响自身、不拖垮其它；结果保持 CANDIDATES 声明顺序，
// 与旧串行实现的输出顺序完全一致（并行只改变「何时」探测，不改变「如何排序」）。
export async function detectShells(
  probe: ProbeFn,
): Promise<{ value: string; label: string }[]> {
  const ok = await Promise.all(CANDIDATES.map((c) => probeCandidate(c, probe)))
  return CANDIDATES.filter((_, i) => ok[i]).map((c) => ({ value: c.value, label: c.label }))
}

// 检测系统可用的 shell 程序列表。结果缓存在实例字段——shell 列表运行时不会变，首次检测后不再重复。
export class ShellDetector {
  // 缓存的是 Promise 而非结果值：detect 变异步后，多个请求可能在首次检测完成前先后到达
  // （旧同步实现天然串行、不存在此窗口）——共享同一个 in-flight Promise 保证只探测一次。
  // detectShells 内部对每个候选全捕获，不会 reject，缓存 rejected promise 的风险不存在。
  private cached: Promise<{ value: string; label: string }[]> | null = null
  private readonly probe: ProbeFn

  // probe 可注入（测试用）；缺省为真实的 execFile 探测。
  constructor(probe: ProbeFn = defaultProbe) {
    this.probe = probe
  }

  detect(): Promise<{ value: string; label: string }[]> {
    this.cached ??= detectShells(this.probe)
    return this.cached
  }
}
