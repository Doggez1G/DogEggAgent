import { execFileSync } from 'node:child_process'

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

// 检测结果缓存——首次检测后不再重复。
let cached: { value: string; label: string }[] | null = null

// 检测系统可用的 shell 程序列表。
// TUI 同进程运行，直接用 execFileSync 检测（无 shell 注入风险）。
export function detectShells(): { value: string; label: string }[] {
  if (cached) return cached
  const found: { value: string; label: string }[] = []
  for (const c of CANDIDATES) {
    try {
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
