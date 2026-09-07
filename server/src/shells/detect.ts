import { execFileSync } from 'node:child_process'

// 系统 shell 候选——按常见顺序检测。
const CANDIDATES = [
  { cmd: 'powershell', value: 'powershell', label: 'PowerShell' },
  { cmd: 'pwsh', value: 'pwsh', label: 'PowerShell 7' },
  { cmd: 'cmd', value: 'cmd', label: 'Command Prompt (cmd)' },
  { cmd: 'bash', value: 'bash', label: 'Bash' },
  { cmd: 'zsh', value: 'zsh', label: 'Zsh' },
  { cmd: 'sh', value: 'sh', label: 'sh' },
]

// 检测系统可用的 shell 程序列表。
// 用 execFileSync（无 shell）避免 shell 注入；结果缓存在实例字段——shell 列表运行时不会变，首次检测后不再重复。
export class ShellDetector {
  private cached: { value: string; label: string }[] | null = null

  detect(): { value: string; label: string }[] {
    if (this.cached) return this.cached
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
    this.cached = found
    return found
  }
}
