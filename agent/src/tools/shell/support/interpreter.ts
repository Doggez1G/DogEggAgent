import { detectShells, type ShellKind } from './detect'

// shell 解释器解析：把配置里的 shellProgram（可缺省）映射成 spawn 需要的「程序 + 标志」，
// 并标注 kind（语义类别——模型可见的语法引导据此生成）。
//
// 立法（用户确认的设计）：
// - 可用 shell 以本机扫描为准，配置在扫描结果中选择默认——配置的 kind 不在扫描结果内
//   → 回退平台默认（cmd / bash）；
// - powershell（5.1）与 pwsh（7+）是两个 kind：语法能力不同（5.1 无 && ||）；
// - 未知程序名（nu/fish 等未支持解释器）→ 回退平台默认，而非猜测语义；
// - 统一 spawn(program, [flag, command]) 显式指定，不用 { shell: true }。

export interface ShellSpec {
  program: string
  flag: string
  kind: ShellKind
}

export function defaultShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  return platform === 'win32' ? { program: 'cmd', flag: '/c', kind: 'cmd' } : { program: 'bash', flag: '-c', kind: 'bash' }
}

// 已知解释器映射到标准 flag。防御：含非 ASCII 字符的值（如误保存的占位文本）回退平台默认。
export function resolveShell(program: string | undefined, platform: NodeJS.Platform = process.platform, detected: ShellKind[] = detectShells(platform)): ShellSpec {
  if (!program || !program.trim()) return defaultShell(platform)
  if (/[^\x00-\x7F]/.test(program)) return defaultShell(platform)
  const map: Record<string, ShellSpec> = {
    cmd: { program: 'cmd', flag: '/c', kind: 'cmd' },
    powershell: { program: 'powershell', flag: '-Command', kind: 'powershell' },
    pwsh: { program: 'pwsh', flag: '-Command', kind: 'pwsh' },
    bash: { program: 'bash', flag: '-c', kind: 'bash' },
    sh: { program: 'sh', flag: '-c', kind: 'sh' },
  }
  const resolved = map[program.toLowerCase()]
  if (!resolved) return defaultShell(platform) // 未知解释器：不猜测语义，回退平台默认
  if (!detected.includes(resolved.kind)) return defaultShell(platform) // 配置了本机没有的 shell：回退平台默认
  return resolved
}
