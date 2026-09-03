import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 系统 shell 候选——按常见顺序检测。
const CANDIDATES = [
  { cmd: 'powershell', value: 'powershell', label: 'PowerShell' },
  { cmd: 'pwsh', value: 'pwsh', label: 'PowerShell 7' },
  { cmd: 'cmd', value: 'cmd', label: 'Command Prompt (cmd)' },
  { cmd: 'bash', value: 'bash', label: 'Bash' },
  { cmd: 'zsh', value: 'zsh', label: 'Zsh' },
  { cmd: 'sh', value: 'sh', label: 'sh' },
]

// 检测结果缓存——首次检测后不再重复（shell 列表在运行时不会变）。
let cached: { value: string; label: string }[] | null = null

// 检测系统可用的 shell 程序列表。
// 用 execFile（无 shell）替代 execSync，避免 shell 注入 + 不阻塞事件循环。
// 结果缓存：第一次调用后后续直接返回缓存。
export function detectShells(): { value: string; label: string }[] {
  if (cached) return cached
  // 同步检测（在首次请求时执行，后续缓存）——用 execFileSync 替代 execSync 避免 shell 注入。
  // 由于 detectShells 在请求处理中被调用且需要同步返回，这里仍用同步方式但加了缓存。
  const { execFileSync } = require('node:child_process')
  const found: { value: string; label: string }[] = []
  for (const c of CANDIDATES) {
    try {
      // 用 execFileSync 直接调用命令（不通过 shell），避免注入风险。
      execFileSync(c.cmd, ['--version'], { timeout: 3000, stdio: 'pipe' })
      found.push({ value: c.value, label: c.label })
    } catch {
      // cmd --version 在 Windows 会失败，尝试无参数调用。
      try {
        execFileSync(c.cmd, ['/c', 'exit 0'], { timeout: 3000, stdio: 'pipe' })
        found.push({ value: c.value, label: c.label })
      } catch {
        // shell not available — skip
      }
    }
  }
  cached = found
  return found
}
