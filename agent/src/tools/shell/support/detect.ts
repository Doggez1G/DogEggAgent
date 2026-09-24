import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 本机可用 shell 扫描（立法：配置只在扫描结果中选择，扫描不到的不允许配置生效）。
// 检测方式：PATH 扫描（比逐个 spawn 探测快且确定）；cmd 在 Windows 上视为必然可用（System32）。
// powershell.exe = Windows PowerShell 5.1；pwsh.exe = PowerShell 7+——两者语法能力不同，
// 必须区分为两个 kind（5.1 不支持 && ||，7 支持）。

export type ShellKind = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh'

const EXE_NAME: Record<ShellKind, string> = {
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
  pwsh: 'pwsh.exe',
  bash: 'bash.exe',
  sh: 'sh',
}

// PATH 扫描：EXE_NAME 自带扩展名（powershell.exe 等），PATHEXT 是补充而非替代——
// 先按裸名找，再按 PATHEXT 补扩展名找。若只做「exe+ext」拼接，检查的会是
// powershell.exe.EXE（永不存在），powershell/pwsh/bash 在 Windows 上恒扫描不到。
// Unix 下 exts=['']，等价于只按裸名找（行为不变）。
function findOnPath(exe: string, platform: NodeJS.Platform): boolean {
  const dirs = (process.env.PATH ?? '').split(platform === 'win32' ? ';' : ':')
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of dirs) {
    if (!dir) continue
    const base = dir.trim()
    if (existsSync(join(base, exe))) return true
    for (const ext of exts) {
      if (!ext) continue // 裸名已查过；空扩展名（含 PATHEXT 尾分号产生的空段）无需重复
      if (existsSync(join(base, exe + ext))) return true
    }
  }
  return false
}

let cached: ShellKind[] | null = null

// 扫描本机可用 shell（结果缓存——运行期不变）。
export function detectShells(platform: NodeJS.Platform = process.platform): ShellKind[] {
  if (cached) return cached
  if (platform === 'win32') {
    // cmd 是 Windows 的基线解释器（System32 恒在）；其余按 PATH 扫描。
    cached = (['cmd', 'powershell', 'pwsh', 'bash'] as ShellKind[]).filter((k) => k === 'cmd' || findOnPath(EXE_NAME[k], platform))
  } else {
    // Unix：sh 视为基线；bash 按 PATH 扫描。
    cached = (['bash', 'sh'] as ShellKind[]).filter((k) => k === 'sh' || findOnPath(EXE_NAME[k], platform))
  }
  return cached
}

// 测试专用：重置扫描缓存（注入受控的 PATH 前调用）。
export function resetDetectCache(): void {
  cached = null
}
